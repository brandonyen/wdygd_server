import * as crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID!;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET!;
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI!;
const STATE_SECRET = process.env.STATE_SECRET!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

// 10-minute window for OAuth state
const STATE_EXPIRY_MS = 10 * 60 * 1000;

function validateState(state: string): { userId: string; finalRedirectUrl?: string } {
  const { payload, hmac, finalRedirectUrl } = JSON.parse(
    Buffer.from(state, "base64url").toString(),
  );

  const expectedHmac = crypto
    .createHmac("sha256", STATE_SECRET)
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

function buildRedirect(finalRedirectUrl: string | undefined, params: Record<string, string>) {
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

export const handler = async (event: any) => {
  const { code, state, error } = event.queryStringParameters ?? {};

  if (error) {
    console.error("Slack OAuth error:", error);
    return { statusCode: 400, body: JSON.stringify({ error }) };
  }

  if (!code || !state) {
    return { statusCode: 400, body: JSON.stringify({ error: "missing_oauth_params" }) };
  }

  let userId: string;
  let finalRedirectUrl: string | undefined;
  try {
    ({ userId, finalRedirectUrl } = validateState(state));
  } catch (err) {
    console.error("State validation failed:", err);
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_state" }) };
  }

  // Exchange authorization code for access token
  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: SLACK_REDIRECT_URI,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    ok: boolean;
    error?: string;
    authed_user: {
      id: string;
      access_token: string;
      refresh_token?: string;
      token_expiration?: number;
    };
  };

  if (!tokenData.ok) {
    console.error("Slack token exchange failed:", tokenData.error);
    return buildRedirect(finalRedirectUrl, { error: tokenData.error ?? "token_exchange_failed" });
  }

  const authedUser = tokenData.authed_user;
  const accessToken: string = authedUser.access_token;
  const refreshToken: string | null = authedUser.refresh_token ?? null;
  const tokenExpiration: string | null = authedUser.token_expiration
    ? new Date(authedUser.token_expiration * 1000).toISOString()
    : null;

  // Upsert into Supabase IntegrationConnection
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data: existing, error: fetchError } = await supabase
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
    const { error: updateError } = await supabase
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
    const { error: insertError } = await supabase
      .from("IntegrationConnection")
      .insert({
        integration_id: crypto.randomUUID(),
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
    return { statusCode: 302, headers: { Location: redirectUrl.toString() }, body: "" };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, message: "Slack account connected successfully" }),
  };
};
