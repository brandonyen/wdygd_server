import { getSupabase } from "../utils/get-supabase-client";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const lambdaClient = new LambdaClient({});
const sqsClient = new SQSClient({});

interface IntegrationConnection {
  integration_id: string;
  user_id: string;
  provider: "GITHUB" | "SLACK";
  token_expiration: string | null;
  access_token: string;
  refresh_token: string | null;
}

async function refreshSlackToken(refreshToken: string) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Slack credentials for token refresh");
  }

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = (await response.json()) as any;
  if (!data.ok) {
    throw new Error(`Slack token refresh failed: ${data.error}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token, // might be unchanged or new
    expires_in: data.expires_in, // in seconds
  };
}

async function refreshGitHubToken(refreshToken: string) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GitHub credentials for token refresh");
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = (await response.json()) as any;
  if (data.error) {
    throw new Error(`GitHub token refresh failed: ${data.error_description}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}

exports.handler = async (event: any) => {
  console.log("Ingestion triggered with records:", event.Records.length);
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
      .select("*")
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

      let accessToken = integration.access_token;

      // Check if expired
      if (
        integration.token_expiration &&
        new Date(integration.token_expiration) <= new Date()
      ) {
        console.log(
          `Token expired for ${integration.provider}, attempting refresh...`,
        );

        if (!integration.refresh_token) {
          console.error(
            `Cannot refresh token for ${integration.provider}: No refresh_token available.`,
          );
          continue;
        }

        try {
          let refreshResult;
          if (integration.provider === "SLACK") {
            refreshResult = await refreshSlackToken(integration.refresh_token);
          } else if (integration.provider === "GITHUB") {
            refreshResult = await refreshGitHubToken(integration.refresh_token);
          } else {
            console.warn(
              `Token refresh not implemented for provider ${integration.provider}`,
            );
            continue;
          }

          accessToken = refreshResult.access_token;
          const newExpiration = refreshResult.expires_in
            ? new Date(
                Date.now() + refreshResult.expires_in * 1000,
              ).toISOString()
            : null;

          // Update DB
          const { error: updateError } = await (
            supabase.from("IntegrationConnection") as any
          )
            .update({
              access_token: refreshResult.access_token,
              refresh_token: refreshResult.refresh_token,
              token_expiration: newExpiration,
            })
            .eq("integration_id", integration.integration_id);

          if (updateError) {
            console.error(
              "Failed to update IntegrationConnection with refreshed tokens:",
              updateError,
            );
          } else {
            console.log("Successfully refreshed and updated token.");
          }
        } catch (refreshErr) {
          console.error("Token refresh failed:", refreshErr);
          continue; // Skip this integration if we can't refresh
        }
      }

      // Call the respective Lambda function
      try {
        if (integration.provider === "SLACK") {
          const lambdaArn = process.env.SLACK_LAMBDA_ARN;
          if (!lambdaArn) throw new Error("SLACK_LAMBDA_ARN is not defined");

          const invokeCmd = new InvokeCommand({
            FunctionName: lambdaArn,
            Payload: JSON.stringify({
              startDate: startDateISO,
              endDate,
              userId: integration.user_id,
              integrationId: integration.integration_id,
            }),
          });

          await lambdaClient.send(invokeCmd);
          console.log("Successfully invoked Slack lambda");
        } else if (integration.provider === "GITHUB") {
          const lambdaArn = process.env.GITHUB_LAMBDA_ARN;
          if (!lambdaArn) throw new Error("GITHUB_LAMBDA_ARN is not defined");

          // For github lambda, it expects APIGatewayProxyEvent
          const invokeCmd = new InvokeCommand({
            FunctionName: lambdaArn,
            Payload: JSON.stringify({
              body: JSON.stringify({
                userId: integration.user_id,
                owner: "TODO_OWNER", // Note: Github params require owner and repo
                repo: "TODO_REPO",
                startDate: startDateISO,
                endDate,
              }),
            }),
          });

          await lambdaClient.send(invokeCmd);
          console.log("Successfully invoked GitHub lambda");
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
