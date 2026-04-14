import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "node:path";

export class WdygdServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Backend entry (health check / debug echo) ---
    const fn = new lambda.Function(this, "BackendApiFn", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/backend-entry-lambda"),
      ),
    });

    // --- API Gateway (shared across all routes) ---
    // LambdaRestApi creates a {proxy+} catch-all to fn.
    // Specific resources added below take precedence over the proxy.
    const endpoint = new apigw.LambdaRestApi(this, "BackendApiGwEndpoint", {
      handler: fn,
      restApiName: "BackendApi",
      proxy: false,
    });

    // --- Slack data-fetch lambda (invoked internally / on schedule) ---
    new lambdaNode.NodejsFunction(this, "SlackIntegrationFn", {
      entry: path.join(
        __dirname,
        "..",
        "functions/integrations/slack/index.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(300),
    });

    // --- Slack OAuth: /oauth/slack/initiate ---
    // Required env vars: SLACK_CLIENT_ID, SLACK_REDIRECT_URI, STATE_SECRET
    const slackOAuthInitiateFn = new lambdaNode.NodejsFunction(
      this,
      "SlackOAuthInitiateFn",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/integrations/slack/oauth/initiate.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        environment: {
          SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID ?? "",
          SLACK_REDIRECT_URI: process.env.SLACK_REDIRECT_URI ?? "",
          STATE_SECRET: process.env.STATE_SECRET ?? "",
        },
      },
    );

    // --- Slack OAuth: /oauth/slack/callback ---
    // Required env vars: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI,
    //                    STATE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FRONTEND_URL
    const slackOAuthCallbackFn = new lambdaNode.NodejsFunction(
      this,
      "SlackOAuthCallbackFn",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/integrations/slack/oauth/callback.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        environment: {
          SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID ?? "",
          SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET ?? "",
          SLACK_REDIRECT_URI: process.env.SLACK_REDIRECT_URI ?? "",
          STATE_SECRET: process.env.STATE_SECRET ?? "",
          SUPABASE_URL: process.env.SUPABASE_URL ?? "",
          SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          FRONTEND_URL: process.env.FRONTEND_URL ?? "",
        },
      },
    );

    // Route: GET /oauth/slack/initiate  →  slackOAuthInitiateFn
    // Route: GET /oauth/slack/callback  →  slackOAuthCallbackFn
    const oauthResource = endpoint.root.addResource("oauth");
    const slackOAuthResource = oauthResource.addResource("slack");
    slackOAuthResource
      .addResource("initiate")
      .addMethod("GET", new apigw.LambdaIntegration(slackOAuthInitiateFn));
    slackOAuthResource
      .addResource("callback")
      .addMethod("GET", new apigw.LambdaIntegration(slackOAuthCallbackFn));
  }
}
