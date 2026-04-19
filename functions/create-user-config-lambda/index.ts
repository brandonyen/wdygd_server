import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

exports.handler = async (event: any) => {
  console.log("Create user config triggered.");

  try {
    const body = JSON.parse(event.body || "{}");
    const { email } = body;

    if (!email) {
      return {
        statusCode: 400,
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
        body: JSON.stringify({ message: "Error checking database", error: fetchError }),
      };
    }

    if (existingUser) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "User already exists", data: existingUser }),
      };
    }

    // Insert if doesn't exist (user_id is auto-generated)
    const { data, error } = await supabase
      .from("UserConfig")
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
        body: JSON.stringify({ message: "Error writing to database", error }),
      };
    }

    return {
      statusCode: 201,
      body: JSON.stringify({ message: "User config created successfully", data }),
    };
  } catch (err) {
    console.error("Unexpected error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
