import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getTokenStore, type StoredToken } from "./token-store.js";

// ============================================================================
// Types
// ============================================================================

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  login: string;
}

// ============================================================================
// Configuration
// ============================================================================

function getConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing required environment variables: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI"
    );
  }

  return { clientId, clientSecret, redirectUri };
}

// ============================================================================
// OAuth Flow Handlers
// ============================================================================

/**
 * Initiates the GitHub OAuth flow by redirecting to GitHub's authorization page
 * GET /auth/github?userId=xxx&redirectUrl=xxx
 */
async function handleInitiate(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const { clientId, redirectUri } = getConfig();

  const userId = event.queryStringParameters?.userId;
  const finalRedirectUrl = event.queryStringParameters?.redirectUrl;

  if (!userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "userId query parameter is required" }),
    };
  }

  // State parameter to prevent CSRF and pass data through the OAuth flow
  const state = Buffer.from(
    JSON.stringify({ userId, finalRedirectUrl })
  ).toString("base64");

  // GitHub OAuth scopes needed for reading repo data
  const scopes = ["repo", "read:user"].join(" ");

  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);

  return {
    statusCode: 302,
    headers: {
      Location: authUrl.toString(),
    },
    body: "",
  };
}

/**
 * Handles the OAuth callback from GitHub
 * GET /auth/github/callback?code=xxx&state=xxx
 */
async function handleCallback(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const { clientId, clientSecret } = getConfig();

  const code = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  const error = event.queryStringParameters?.error;

  if (error) {
    const errorDescription =
      event.queryStringParameters?.error_description || "Unknown error";
    return {
      statusCode: 400,
      body: JSON.stringify({ error, description: errorDescription }),
    };
  }

  if (!code || !state) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing code or state parameter" }),
    };
  }

  // Decode state to get userId and redirect URL
  let stateData: { userId: string; finalRedirectUrl?: string };
  try {
    stateData = JSON.parse(Buffer.from(state, "base64").toString("utf-8"));
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid state parameter" }),
    };
  }

  // Exchange code for access token
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    }
  );

  const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;

  if (tokenData.error) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: tokenData.error,
        description: tokenData.error_description,
      }),
    };
  }

  // Get GitHub user info
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!userResponse.ok) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch GitHub user info" }),
    };
  }

  const userData = (await userResponse.json()) as GitHubUser;

  // Store the token
  const tokenStore = getTokenStore();
  const storedToken: StoredToken = {
    accessToken: tokenData.access_token,
    tokenType: tokenData.token_type,
    scope: tokenData.scope,
    createdAt: new Date().toISOString(),
    githubUserId: userData.id,
    githubUsername: userData.login,
  };

  await tokenStore.saveToken(stateData.userId, storedToken);

  // Redirect to final URL or return success
  if (stateData.finalRedirectUrl) {
    const redirectUrl = new URL(stateData.finalRedirectUrl);
    redirectUrl.searchParams.set("success", "true");
    redirectUrl.searchParams.set("github_username", userData.login);

    return {
      statusCode: 302,
      headers: {
        Location: redirectUrl.toString(),
      },
      body: "",
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      success: true,
      message: "GitHub account connected successfully",
      githubUsername: userData.login,
    }),
  };
}

/**
 * Check connection status for a user
 * GET /auth/github/status?userId=xxx
 */
async function handleStatus(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const userId = event.queryStringParameters?.userId;

  if (!userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "userId query parameter is required" }),
    };
  }

  const tokenStore = getTokenStore();
  const token = await tokenStore.getToken(userId);

  if (!token) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        connected: false,
      }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      connected: true,
      githubUsername: token.githubUsername,
      connectedAt: token.createdAt,
      scopes: token.scope.split(","),
    }),
  };
}

/**
 * Disconnect GitHub account
 * DELETE /auth/github?userId=xxx
 */
async function handleDisconnect(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const userId = event.queryStringParameters?.userId;

  if (!userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "userId query parameter is required" }),
    };
  }

  const tokenStore = getTokenStore();
  await tokenStore.deleteToken(userId);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      message: "GitHub account disconnected",
    }),
  };
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const path = event.path ?? "";
    const method = event.httpMethod ?? "";

    // Route based on path and method
    if (path.endsWith("/callback") && method === "GET") {
      return handleCallback(event);
    }

    if (path.endsWith("/status") && method === "GET") {
      return handleStatus(event);
    }

    if (method === "DELETE") {
      return handleDisconnect(event);
    }

    if (method === "GET") {
      return handleInitiate(event);
    }

    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (error) {
    console.error("OAuth error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage }),
    };
  }
}
