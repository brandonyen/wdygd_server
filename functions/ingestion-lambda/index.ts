import { getSupabase } from "../utils/get-supabase-client";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const lambdaClient = new LambdaClient({});
const sqsClient = new SQSClient({});

interface IntegrationConnection {
  integration_id: string;
  user_id: string;
  provider: "GITHUB" | "SLACK";
}

exports.handler = async (event: any) => {
  console.log(
    `Ingestion lambda triggered with ${event.Records?.length || 0} records.`,
  );
  const supabase = await getSupabase();

  for (const record of event.Records) {
    const payload = JSON.parse(record.body);
    const userId = payload.userId;
    const startDateISO = payload.startDate;
    const endDate = payload.endDate;
    console.log("Processing ingestion for user:", userId);

    // 1. Fetch IntegrationConnections
    const { data: connections, error } = await supabase
      .from("IntegrationConnection")
      .select("integration_id, user_id, provider")
      .eq("user_id", userId);

    if (error) {
      console.error(
        `Failed to fetch integration connections for user ${userId}:`,
        error,
      );
      continue;
    }

    if (!connections || connections.length === 0) {
      console.log(`No integration connections found for user ${userId}`);
      continue;
    }

    const integrations = connections as IntegrationConnection[];

    for (const integration of integrations) {
      console.log(
        `Processing integration ${integration.provider} (${integration.integration_id})`,
      );

      // Call the respective Lambda function
      try {
        if (integration.provider === "SLACK") {
          const lambdaArn = process.env.SLACK_LAMBDA_ARN;
          if (!lambdaArn) throw new Error("SLACK_LAMBDA_ARN is not defined");

          const invokeCmd = new InvokeCommand({
            FunctionName: lambdaArn,
            InvocationType: "RequestResponse",
            Payload: JSON.stringify({
              startDate: startDateISO,
              endDate,
              userId: integration.user_id,
              integrationId: integration.integration_id,
            }),
          });

          await lambdaClient.send(invokeCmd);
          console.log("Successfully invoked Slack lambda synchronously");
        } else if (integration.provider === "GITHUB") {
          const lambdaArn = process.env.GITHUB_LAMBDA_ARN;
          if (!lambdaArn) throw new Error("GITHUB_LAMBDA_ARN is not defined");

          const invokeCmd = new InvokeCommand({
            FunctionName: lambdaArn,
            InvocationType: "RequestResponse",
            Payload: JSON.stringify({
              userId: integration.user_id,
              integrationId: integration.integration_id,
              startDate: startDateISO,
              endDate,
            }),
          });

          await lambdaClient.send(invokeCmd);
          console.log("Successfully invoked GitHub lambda synchronously");
        }
      } catch (invokeErr) {
        console.error(
          `Failed to invoke lambda for ${integration.provider}:`,
          invokeErr,
        );
      }
    }

    // Now push to Summary Queue
    const summaryQueueUrl = process.env.SUMMARY_QUEUE_URL;
    if (summaryQueueUrl) {
      const summaryMsg = {
        user_id: userId,
        start_date: startDateISO,
        end_date: endDate,
        summary_type: "DAILY",
      };

      try {
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: summaryQueueUrl,
            MessageBody: JSON.stringify(summaryMsg),
          }),
        );
        console.log(`Sent summary job for user ${userId} to SummaryQueue`);
      } catch (sqsErr) {
        console.error(
          `Failed to send summary job to SQS for user ${userId}:`,
          sqsErr,
        );
      }
    } else {
      console.warn("SUMMARY_QUEUE_URL not defined, skipping summary trigger");
    }
  }
};
