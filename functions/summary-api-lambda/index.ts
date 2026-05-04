import { getSupabase } from "../utils/get-supabase-client";
import { generateSummary } from "../utils/generate-summary";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export const handler = async (event: any) => {
  const httpMethod = event.httpMethod;
  console.log(`Summary API triggered with method: ${httpMethod}`);

  if (httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  try {
    const supabase = await getSupabase();

    if (httpMethod === "GET") {
      const user_id = event.queryStringParameters?.user_id;
      const start_date = event.queryStringParameters?.start_date;
      const end_date = event.queryStringParameters?.end_date;
      const summary_type = event.queryStringParameters?.summary_type;

      if (!user_id) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ message: "Missing user_id" }),
        };
      }

      let query = (supabase.from("Summary") as any)
        .select("*")
        .eq("user_id", user_id);

      if (start_date) query = query.gte("start_date", start_date);
      if (end_date) query = query.lte("end_date", end_date);
      if (summary_type) query = query.eq("summary_type", summary_type);

      query = query.order("created_at", { ascending: false });

      const { data, error } = await query;

      if (error) {
        throw new Error(`Failed to fetch summaries: ${error.message}`);
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ data }),
      };
    }

    if (httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { user_id, start_date, end_date } = body;
      const summary_type = body.summary_type || "USER_GENERATED";

      if (!user_id || !start_date || !end_date) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Missing required fields: user_id, start_date, end_date",
          }),
        };
      }

      const { summary } = await generateSummary(
        user_id,
        start_date,
        end_date,
        summary_type
      );

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ data: summary, message: "Summary generated successfully" }),
      };
    }

    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ message: "Method Not Allowed" }),
    };
  } catch (err: any) {
    console.error("Summary API Error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: err.message || "Internal server error" }),
    };
  }
};
