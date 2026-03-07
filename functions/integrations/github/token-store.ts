import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface StoredToken {
  accessToken: string;
  tokenType: string;
  scope: string;
  createdAt: string;
  // GitHub user info
  githubUserId: number;
  githubUsername: string;
}

export interface TokenStore {
  getToken(userId: string): Promise<StoredToken | null>;
  saveToken(userId: string, token: StoredToken): Promise<void>;
  deleteToken(userId: string): Promise<void>;
}

// ============================================================================
// Local File Store (Development Only)
// ============================================================================

const LOCAL_STORE_PATH = path.join("/tmp", "github-tokens.json");

function readLocalStore(): Record<string, StoredToken> {
  try {
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const data = fs.readFileSync(LOCAL_STORE_PATH, "utf-8");
      return JSON.parse(data);
    }
  } catch {
    // Ignore errors, return empty store
  }
  return {};
}

function writeLocalStore(store: Record<string, StoredToken>): void {
  fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(store, null, 2));
}

export const localFileStore: TokenStore = {
  async getToken(userId: string): Promise<StoredToken | null> {
    const store = readLocalStore();
    return store[userId] || null;
  },

  async saveToken(userId: string, token: StoredToken): Promise<void> {
    const store = readLocalStore();
    store[userId] = token;
    writeLocalStore(store);
  },

  async deleteToken(userId: string): Promise<void> {
    const store = readLocalStore();
    delete store[userId];
    writeLocalStore(store);
  },
};

// ============================================================================
// DynamoDB Store (Production - Placeholder)
// ============================================================================

// TODO: Implement DynamoDB store when ready
// export const dynamoDBStore: TokenStore = { ... }

// ============================================================================
// Default Export
// ============================================================================

// Use environment variable to switch stores
export function getTokenStore(): TokenStore {
  const storeType = process.env.TOKEN_STORE_TYPE || "local";

  switch (storeType) {
    case "dynamodb":
      // return dynamoDBStore;
      throw new Error("DynamoDB store not implemented yet");
    case "local":
    default:
      return localFileStore;
  }
}
