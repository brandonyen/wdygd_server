import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { getSupabase } from "../utils/get-supabase-client";
import { checkExistingSummary } from "../utils/check-existing-summary";

const sqsClient = new SQSClient({});
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export const handler = async (event: any) => {
  console.log(`Ingestion API triggered with method: ${event.httpMethod}`);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { user_id, start_date, end_date } = body;
    const summary_type = body.summary_type || "DAILY";
    console.log(`Ingestion requested for user_id: ${user_id}`);

    if (!user_id) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ message: "Missing required field: user_id" }),
      };
    }

    let endDate: Date;
    let startDate: Date;

    if (start_date && end_date) {
      startDate = new Date(start_date);
      endDate = new Date(end_date);
      
      const MAX_DAYS = 31;
      const msDiff = endDate.getTime() - startDate.getTime();
      const daysDiff = msDiff / (1000 * 60 * 60 * 24);
      
      if (daysDiff > MAX_DAYS) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ message: "Date range cannot exceed 31 days." }),
        };
      }
    } else {
      endDate = new Date();
      startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
    }

    // 1. Check for existing summary
    const existing = await checkExistingSummary(
      user_id,
      startDate.toISOString(),
      endDate.toISOString(),
      summary_type,
    );

    if (existing) {
      console.log(`Summary already exists for user ${user_id}, returning existing summary.`);
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          data: existing,
          message: "Summary already exists, returning cached version.",
        }),
      };
    }

    const queueUrl = process.env.INGESTION_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("INGESTION_QUEUE_URL not set");
    }

    console.log(
      `Sending message to IngestionQueue for user_id: ${user_id} with date range ${startDate.toISOString()} to ${endDate.toISOString()} and type ${summary_type}`,
    );
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          userId: user_id,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          summaryType: summary_type,
        }),
      }),
    );

    if (summary_type === "DAILY") {
      const supabase = await getSupabase();
      const { error: updateError } = await (supabase.from("UserConfig") as any)
        .update({ last_sync: endDate.toISOString() })
        .eq("user_id", user_id);

      if (updateError) {
        console.error(`Failed to update last_sync for user ${user_id}:`, updateError);
      } else {
        console.log(`Successfully updated last_sync for user ${user_id} to ${endDate.toISOString()}`);
      }
    }

    return {
      statusCode: 202,
      headers: corsHeaders,
      body: JSON.stringify({
        message:
          "Data collection and summary generation started.",
      }),
    };
  } catch (err: any) {
    console.error("Ingestion API Error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: err.message || "Internal server error" }),
    };
  }
};
