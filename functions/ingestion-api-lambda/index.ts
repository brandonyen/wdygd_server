import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

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
    const { user_id } = body;
    console.log(`Ingestion requested for user_id: ${user_id}`);

    if (!user_id) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ message: "Missing required field: user_id" }),
      };
    }

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);

    const queueUrl = process.env.INGESTION_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("INGESTION_QUEUE_URL not set");
    }

    console.log(
      `Sending message to IngestionQueue for user_id: ${user_id} with date range ${startDate.toISOString()} to ${endDate.toISOString()}`,
    );
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          userId: user_id,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          summaryType: "DAILY",
        }),
      }),
    );

    return {
      statusCode: 202,
      headers: corsHeaders,
      body: JSON.stringify({
        message:
          "Data collection and summary generation started for the past day.",
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
