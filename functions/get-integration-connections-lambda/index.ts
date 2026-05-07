import { getSupabase } from "../utils/get-supabase-client";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export const handler = async (event: any) => {
  console.log("Get integration connections triggered.");

  try {
    const supabase = await getSupabase();
    const httpMethod = event.httpMethod;

    if (httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: "",
      };
    }

    if (httpMethod === "GET") {
      const user_id = event.queryStringParameters?.user_id;
      console.log(`Fetching integration connections for user_id: ${user_id}`);

      if (!user_id) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Missing user_id in query parameters",
          }),
        };
      }

      const { data, error } = await supabase
        .from("IntegrationConnection")
        .select(
          "integration_id, user_id, provider, provider_workspace_id, slack_workspace_name, token_expiration",
        )
        .eq("user_id", user_id);

      if (error) {
        console.error("Error fetching integration connection:", error);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Error fetching from database",
            error,
          }),
        };
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ data }),
      };
    }

    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ message: "Method Not Allowed" }),
    };
  } catch (err) {
    console.error("Unexpected error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
