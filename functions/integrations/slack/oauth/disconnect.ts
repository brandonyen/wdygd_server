import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

export const handler = async (event: any) => {
  const userId = event.queryStringParameters?.userId;

  if (!userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "userId query parameter is required" }),
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
    body: JSON.stringify({ success: true, message: "Slack account disconnected" }),
  };
};
