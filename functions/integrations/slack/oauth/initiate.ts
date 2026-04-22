import * as crypto from "crypto";

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID!;
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI!;
const STATE_SECRET = process.env.STATE_SECRET!;

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

export const handler = async (event: any) => {
  const userId = event.queryStringParameters?.userId;

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
    .createHmac("sha256", STATE_SECRET)
    .update(payload)
    .digest("hex");

  const finalRedirectUrl = event.queryStringParameters?.redirectUrl;

  const state = Buffer.from(
    JSON.stringify({ payload, hmac, finalRedirectUrl }),
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    user_scope: USER_SCOPES,
    redirect_uri: SLACK_REDIRECT_URI,
    state,
  });

  return {
    statusCode: 302,
    headers: { Location: `https://slack.com/oauth/v2/authorize?${params}` },
    body: "",
  };
};
