import { getSupabase } from "../utils/get-supabase-client";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

exports.handler = async (event: any) => {
  console.log("Create user config triggered.");

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

    if (httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { email } = body;

      if (!email) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ message: "Missing email" }),
        };
      }

      // Check if email already exists
      const { data: existingUser, error: fetchError } = await supabase
        .from("UserConfig")
        .select("email")
        .eq("email", email)
        .maybeSingle();

      if (fetchError) {
        console.error("Error checking existing user:", fetchError);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Error checking database",
            error: fetchError,
          }),
        };
      }

      if (existingUser) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "User already exists",
            data: existingUser,
          }),
        };
      }

      // Insert if doesn't exist (user_id is auto-generated)
      // Cast the chain as any to bypass the strict type requirement
      const { data, error } = await (supabase.from("UserConfig") as any)
        .insert([
          {
            email,
            created_at: new Date().toISOString(),
            last_sync: new Date().toISOString(),
          },
        ])
        .select();

      if (error) {
        console.error("Error inserting user config:", error);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({ message: "Error writing to database", error }),
        };
      }

      return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify({
          message: "User config created successfully",
          data,
        }),
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
