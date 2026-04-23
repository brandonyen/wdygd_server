import { getSupabase } from "../../../utils/get-supabase-client";

export const handler = async (event: any) => {
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
};
