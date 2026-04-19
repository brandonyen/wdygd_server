// ============================================================================
// Types
// ============================================================================

export interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiration: string | null;
  createdAt: string;
}

export interface TokenStore {
  getToken(userId: string): Promise<StoredToken | null>;
  saveToken(userId: string, token: StoredToken): Promise<void>;
  deleteToken(userId: string): Promise<void>;
}

// ============================================================================
// Supabase Store (IntegrationConnection table)
// ============================================================================

interface IntegrationConnectionRow {
  integration_id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  token_expiration: string | null;
  created_at?: string;
}

function getSupabaseStore(): TokenStore {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing required environment variables: SUPABASE_URL, SUPABASE_KEY");
  }

  const baseUrl = `${supabaseUrl}/rest/v1/IntegrationConnection`;
  const headers: Record<string, string> = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
  };

  return {
    async getToken(userId: string): Promise<StoredToken | null> {
      const res = await fetch(
        `${baseUrl}?user_id=eq.${encodeURIComponent(userId)}&provider=eq.GITHUB&select=*`,
        { headers },
      );

      if (!res.ok) {
        throw new Error(`Supabase query failed: ${res.status} ${await res.text()}`);
      }

      const rows = (await res.json()) as IntegrationConnectionRow[];
      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        tokenExpiration: row.token_expiration,
        createdAt: row.created_at ?? new Date().toISOString(),
      };
    },

    async saveToken(userId: string, token: StoredToken): Promise<void> {
      // Check if a GitHub connection already exists for this user
      const checkRes = await fetch(
        `${baseUrl}?user_id=eq.${encodeURIComponent(userId)}&provider=eq.GITHUB&select=integration_id`,
        { headers },
      );

      if (!checkRes.ok) {
        throw new Error(`Supabase query failed: ${checkRes.status} ${await checkRes.text()}`);
      }

      const existing = (await checkRes.json()) as { integration_id: string }[];

      if (existing.length > 0) {
        // Update existing row
        const integrationId = existing[0].integration_id;
        const updateRes = await fetch(
          `${baseUrl}?integration_id=eq.${encodeURIComponent(integrationId)}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              access_token: token.accessToken,
              refresh_token: token.refreshToken,
              token_expiration: token.tokenExpiration,
            }),
          },
        );

        if (!updateRes.ok) {
          throw new Error(`Supabase update failed: ${updateRes.status} ${await updateRes.text()}`);
        }
      } else {
        // Insert new row
        const insertRes = await fetch(baseUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            integration_id: crypto.randomUUID(),
            user_id: userId,
            provider: "GITHUB",
            access_token: token.accessToken,
            refresh_token: token.refreshToken,
            token_expiration: token.tokenExpiration,
          }),
        });

        if (!insertRes.ok) {
          throw new Error(`Supabase insert failed: ${insertRes.status} ${await insertRes.text()}`);
        }
      }
    },

    async deleteToken(userId: string): Promise<void> {
      const res = await fetch(
        `${baseUrl}?user_id=eq.${encodeURIComponent(userId)}&provider=eq.GITHUB`,
        { method: "DELETE", headers },
      );

      if (!res.ok) {
        throw new Error(`Supabase delete failed: ${res.status} ${await res.text()}`);
      }
    },
  };
}

// ============================================================================
// Default Export
// ============================================================================

export function getTokenStore(): TokenStore {
  return getSupabaseStore();
}
