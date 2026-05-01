import { getSupabase } from "../utils/get-supabase-client";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export const handler = async (event: any) => {
  console.log("Get user config triggered.");

  try {
    const supabase = await getSupabase();
    const httpMethod = event.httpMethod;

    if (httpMethod === "GET") {
      const email = event.queryStringParameters?.email;

      if (!email) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Missing email in query parameters",
          }),
        };
      }

      const { data, error } = await supabase
        .from("UserConfig")
        .select("*")
        .eq("email", email)
        .maybeSingle();

      if (error) {
        console.error("Error fetching user config:", error);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Error fetching from database",
            error,
          }),
        };
      }

      if (!data) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ message: "User not found" }),
        };
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ data }),
      };
    }

    // Fallback for unsupported methods
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
