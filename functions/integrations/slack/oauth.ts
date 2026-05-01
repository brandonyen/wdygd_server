import * as crypto from "crypto";
import { getSupabase } from "../../utils/get-supabase-client";

// ============================================================================
// Configuration
// ============================================================================

function getConfig() {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const redirectUri = process.env.SLACK_REDIRECT_URI;
  const stateSecret = process.env.STATE_SECRET;

  if (!clientId || !clientSecret || !redirectUri || !stateSecret) {
    throw new Error("Missing required environment variables for Slack OAuth");
  }

  return { clientId, clientSecret, redirectUri, stateSecret };
}

const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
].join(",");

const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10-minute window for OAuth state

// ============================================================================
// Helpers
// ============================================================================

function validateState(
  state: string,
  stateSecret: string,
): {
  userId: string;
  finalRedirectUrl?: string;
} {
  const { payload, hmac, finalRedirectUrl } = JSON.parse(
    Buffer.from(state, "base64url").toString(),
  );

  const expectedHmac = crypto
    .createHmac("sha256", stateSecret)
    .update(payload)
    .digest("hex");

  if (
    !crypto.timingSafeEqual(
      Buffer.from(hmac, "hex"),
      Buffer.from(expectedHmac, "hex"),
    )
  ) {
    throw new Error("Invalid state signature");
  }

  const [userId, timestamp] = payload.split(":");
  if (Date.now() - parseInt(timestamp) > STATE_EXPIRY_MS) {
    throw new Error("State expired");
  }

  return { userId, finalRedirectUrl };
}

function buildRedirect(
  finalRedirectUrl: string | undefined,
  params: Record<string, string>,
) {
  if (finalRedirectUrl) {
    const url = new URL(finalRedirectUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return { statusCode: 302, headers: { Location: url.toString() }, body: "" };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  };
}

// ============================================================================
// Handlers
// ============================================================================

async function handleInitiate(event: any): Promise<any> {
  const { clientId, redirectUri, stateSecret } = getConfig();
  const userId = event.queryStringParameters?.userId;
  const finalRedirectUrl = event.queryStringParameters?.redirectUrl;

  if (!userId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "userId query parameter is required" }),
    };
  }

  // Build HMAC-signed state to prevent CSRF and bind the flow to user_id
  const timestamp = Date.now().toString();
  const payload = `${userId}:${timestamp}`;
  const hmac = crypto
    .createHmac("sha256", stateSecret)
    .update(payload)
    .digest("hex");

  const state = Buffer.from(
    JSON.stringify({ payload, hmac, finalRedirectUrl }),
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    user_scope: USER_SCOPES,
    redirect_uri: redirectUri,
    state,
  });

  return {
    statusCode: 302,
    headers: { Location: `https://slack.com/oauth/v2/authorize?${params}` },
    body: "",
  };
}

async function handleCallback(event: any): Promise<any> {
  const { clientId, clientSecret, redirectUri, stateSecret } = getConfig();
  const { code, state, error } = event.queryStringParameters ?? {};

  if (error) {
    console.error("Slack OAuth error:", error);
    return { statusCode: 400, body: JSON.stringify({ error }) };
  }

  if (!code || !state) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "missing_oauth_params" }),
    };
  }

  let userId: string;
  let finalRedirectUrl: string | undefined;
  try {
    ({ userId, finalRedirectUrl } = validateState(state, stateSecret));
  } catch (err) {
    console.error("State validation failed:", err);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "invalid_state" }),
    };
  }

  // Exchange authorization code for access token
  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    ok: boolean;
    error?: string;
    authed_user: {
      id: string;
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
  };

  if (!tokenData.ok) {
    console.error("Slack token exchange failed:", tokenData.error);
    return buildRedirect(finalRedirectUrl, {
      error: tokenData.error ?? "token_exchange_failed",
    });
  }

  const authedUser = tokenData.authed_user;
  const accessToken: string = authedUser.access_token;
  const refreshToken: string | null = authedUser.refresh_token ?? null;
  const tokenExpiration: string | null = authedUser.expires_in
    ? new Date(Date.now() + authedUser.expires_in * 1000).toISOString()
    : null;

  // Upsert into Supabase IntegrationConnection
  const supabase = await getSupabase();

  const { data: existing, error: fetchError } = await (supabase as any)
    .from("IntegrationConnection")
    .select("integration_id")
    .eq("user_id", userId)
    .eq("provider", "SLACK")
    .maybeSingle();

  if (fetchError) {
    console.error("Supabase fetch error:", fetchError);
    return buildRedirect(finalRedirectUrl, { error: "db_error" });
  }

  if (existing) {
    const { error: updateError } = await (supabase as any)
      .from("IntegrationConnection")
      .update({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expiration: tokenExpiration,
      })
      .eq("integration_id", existing.integration_id);

    if (updateError) {
      console.error("Supabase update error:", updateError);
      return buildRedirect(finalRedirectUrl, { error: "db_error" });
    }
  } else {
    const { error: insertError } = await (supabase as any)
      .from("IntegrationConnection")
      .insert({
        user_id: userId,
        provider: "SLACK",
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expiration: tokenExpiration,
      });

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return buildRedirect(finalRedirectUrl, { error: "db_error" });
    }
  }

  if (finalRedirectUrl) {
    const redirectUrl = new URL(finalRedirectUrl);
    redirectUrl.searchParams.set("success", "true");
    return {
      statusCode: 302,
      headers: { Location: redirectUrl.toString() },
      body: "",
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      success: true,
      message: "Slack account connected successfully",
    }),
  };
}

async function handleStatus(event: any): Promise<any> {
  const userId = event.queryStringParameters?.userId;

  if (!userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "userId query parameter is required" }),
    };
  }

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("IntegrationConnection")
    .select("created_at, token_expiration")
    .eq("user_id", userId)
    .eq("provider", "SLACK");

  const rows = data as any[] | null;

  if (error || !rows || rows.length === 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        connected: false,
      }),
    };
  }

  const token = rows[0];

  return {
    statusCode: 200,
    body: JSON.stringify({
      connected: true,
      connectedAt: token.created_at,
      tokenExpiration: token.token_expiration,
    }),
  };
}

async function handleDisconnect(event: any): Promise<any> {
  const userId = event.queryStringParameters?.userId;

  if (!userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "userId query parameter is required" }),
    };
  }

  const supabase = await getSupabase();

  const { error } = await supabase
    .from("IntegrationConnection")
    .delete()
    .eq("user_id", userId)
    .eq("provider", "SLACK");

  if (error) {
    console.error("Supabase delete error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "db_error" }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      message: "Slack account disconnected",
    }),
  };
}

export async function handler(event: any): Promise<any> {
  try {
    const path = event.path ?? "";
    const method = event.httpMethod ?? "";

    if (path.endsWith("/callback") && method === "GET") {
      const res = await handleCallback(event);
      return { ...res, headers: res.headers || {} };
    }

    if (path.endsWith("/status") && method === "GET") {
      const res = await handleStatus(event);
      return { ...res, headers: res.headers || {} };
    }

    if (method === "DELETE") {
      const res = await handleDisconnect(event);
      return { ...res, headers: res.headers || {} };
    }

    if (method === "GET") {
      const res = await handleInitiate(event);
      return { ...res, headers: res.headers || {} };
    }

    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (error) {
    console.error("Slack OAuth error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage }),
    };
  }
}
