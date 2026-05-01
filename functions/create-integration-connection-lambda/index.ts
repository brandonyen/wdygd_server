import { getSupabase } from "../utils/get-supabase-client";

exports.handler = async (event: any) => {
  console.log("Create integration connection triggered.");

  try {
    const supabase = await getSupabase();
    const httpMethod = event.httpMethod;

    if (httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const {
        user_id,
        provider,
        token_expiration,
        access_token,
        refresh_token,
      } = body;

      if (!user_id || !provider || !access_token) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            message:
              "Missing required fields (user_id, provider, access_token)",
          }),
        };
      }

      const { data, error } = await (
        supabase.from("IntegrationConnection") as any
      )
        .insert([
          {
            user_id,
            provider,
            token_expiration: token_expiration
              ? new Date(token_expiration).toISOString()
              : null,
            access_token,
            refresh_token,
          },
        ])
        .select();

      if (error) {
        console.error("Error inserting integration connection:", error);
        return {
          statusCode: 500,
          body: JSON.stringify({ message: "Error writing to database", error }),
        };
      }

      return {
        statusCode: 201,
        body: JSON.stringify({
          message: "Integration connection created successfully",
          data,
        }),
      };
    }

    if (httpMethod === "GET") {
      const user_id = event.queryStringParameters?.user_id;

      if (!user_id) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            message: "Missing user_id in query parameters",
          }),
        };
      }

      const { data, error } = await supabase
        .from("IntegrationConnection")
        .select("*")
        .eq("user_id", user_id);

      if (error) {
        console.error("Error fetching integration connection:", error);
        return {
          statusCode: 500,
          body: JSON.stringify({
            message: "Error fetching from database",
            error,
          }),
        };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ data }),
      };
    }

    return {
      statusCode: 405,
      body: JSON.stringify({ message: "Method Not Allowed" }),
    };
  } catch (err) {
    console.error("Unexpected error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
