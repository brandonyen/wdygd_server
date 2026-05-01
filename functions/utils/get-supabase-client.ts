import { createClient } from "@supabase/supabase-js";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const secretClient = new SecretsManagerClient({});
let supabaseClient: ReturnType<typeof createClient>;

export async function getSupabase() {
  if (supabaseClient) return supabaseClient;

  const secretArn = process.env.SUPABASE_SECRET_ARN;
  if (!secretArn) {
    // Fallback to plain env vars
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (url && key) {
      supabaseClient = createClient(url, key);
      return supabaseClient;
    }
    throw new Error("Missing SUPABASE_URL and SUPABASE_KEY");
  }

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const response = await secretClient.send(command);

  if (!response.SecretString) {
    throw new Error("SecretString is empty");
  }

  const secret = JSON.parse(response.SecretString);
  if (!secret.SUPABASE_URL || !secret.SUPABASE_KEY) {
    throw new Error("Secret does not contain SUPABASE_URL and SUPABASE_KEY");
  }

  supabaseClient = createClient(secret.SUPABASE_URL, secret.SUPABASE_KEY);
  return supabaseClient;
}
