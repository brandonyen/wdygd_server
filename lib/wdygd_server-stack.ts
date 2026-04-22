import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "node:path";

export class WdygdServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Cognito User Pool for Auth
    const existingUserPoolId = this.node.tryGetContext("userPoolId");
    let userPool: cognito.IUserPool;

    if (existingUserPoolId) {
      userPool = cognito.UserPool.fromUserPoolId(
        this,
        "WdygdUserPool",
        existingUserPoolId,
      );
    } else {
      userPool = new cognito.UserPool(this, "WdygdUserPool", {
        userPoolName: "wdygd-user-pool",
        selfSignUpEnabled: true,
        signInAliases: { email: true },
        autoVerify: { email: true },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        passwordPolicy: {
          minLength: 8,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: false,
        },
      });
    }

    const userPoolClient = new cognito.UserPoolClient(
      this,
      "WdygdUserPoolClient",
      {
        userPool,
        generateSecret: false,
      },
    );

    // Fetch Supabase Credentials from Secrets Manager
    const supabaseSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SupabaseSecret",
      "prod/wdygd",
    );

    // Environment Variables resolved via CloudFormation dynamic references
    const defaultEnvironment = {
      SUPABASE_URL: supabaseSecret
        .secretValueFromJson("SUPABASE_URL")
        .unsafeUnwrap(),
      SUPABASE_KEY: supabaseSecret
        .secretValueFromJson("SUPABASE_KEY")
        .unsafeUnwrap(),
      GITHUB_CLIENT_ID: supabaseSecret
        .secretValueFromJson("GITHUB_CLIENT_ID")
        .unsafeUnwrap(),
      GITHUB_CLIENT_SECRET: supabaseSecret
        .secretValueFromJson("GITHUB_CLIENT_SECRET")
        .unsafeUnwrap(),
      GITHUB_REDIRECT_URI: supabaseSecret
        .secretValueFromJson("GITHUB_REDIRECT_URI")
        .unsafeUnwrap(),
    };

    const fn = new lambda.Function(this, "BackendApiFn", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/backend-entry-lambda"),
      ),
      environment: {
        ...defaultEnvironment,
        USER_POOL_ID: userPool.userPoolId,
      },
    });

    const githubFn = new lambda.Function(this, "GitHubIntegrationFn", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/integrations/github"),
      ),
      timeout: cdk.Duration.seconds(30),
    });

    const githubOAuthFn = new lambda.Function(this, "GitHubOAuthFn", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "oauth.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/integrations/github"),
      ),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...defaultEnvironment,
      },
    });

    const endpoint = new apigw.RestApi(this, "BackendApiGwEndpoint", {
      restApiName: "BackendApi",
      defaultIntegration: new apigw.LambdaIntegration(fn),
    });

    // Add catch-all routes to mimic previous LambdaRestApi behavior
    endpoint.root.addMethod("ANY");
    const proxyResource = endpoint.root.addResource("{proxy+}");
    proxyResource.addMethod("ANY");

    // --- Slack OAuth: /oauth/slack/initiate ---
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
        runtime: lambda.Runtime.NODEJS_LATEST,
        environment: {
          SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID ?? "",
          SLACK_REDIRECT_URI: process.env.SLACK_REDIRECT_URI ?? "",
          STATE_SECRET: process.env.STATE_SECRET ?? "",
        },
      },
    );

    // --- Slack OAuth: /oauth/slack/callback ---
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
        runtime: lambda.Runtime.NODEJS_LATEST,
        environment: {
          SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID ?? "",
          SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET ?? "",
          SLACK_REDIRECT_URI: process.env.SLACK_REDIRECT_URI ?? "",
          STATE_SECRET: process.env.STATE_SECRET ?? "",
          SUPABASE_URL: process.env.SUPABASE_URL ?? "",
          SUPABASE_SERVICE_ROLE_KEY:
            process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          FRONTEND_URL: process.env.FRONTEND_URL ?? "",
        },
      },
    );

    // Routes: GET /oauth/slack/initiate and GET /oauth/slack/callback
    const oauthResource = endpoint.root.addResource("oauth");
    const slackOAuthResource = oauthResource.addResource("slack");
    slackOAuthResource
      .addResource("initiate")
      .addMethod("GET", new apigw.LambdaIntegration(slackOAuthInitiateFn));
    slackOAuthResource
      .addResource("callback")
      .addMethod("GET", new apigw.LambdaIntegration(slackOAuthCallbackFn));

    // --- Slack data-fetch lambda (invoked internally / on schedule) ---
    const slackFn = new lambdaNode.NodejsFunction(this, "SlackIntegrationFn", {
      entry: path.join(
        __dirname,
        "..",
        "functions/integrations/slack/index.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_LATEST,
      timeout: cdk.Duration.seconds(300),
      bundling: {
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        ...defaultEnvironment,
      },
    });

    const github = endpoint.root.addResource("github");
    github.addMethod("POST", new apigw.LambdaIntegration(githubFn));

    const auth = endpoint.root.addResource("auth");
    const authGithub = auth.addResource("github");
    authGithub.addMethod("GET", new apigw.LambdaIntegration(githubOAuthFn));
    authGithub.addMethod("DELETE", new apigw.LambdaIntegration(githubOAuthFn));
    authGithub
      .addResource("callback")
      .addMethod("GET", new apigw.LambdaIntegration(githubOAuthFn));
    authGithub
      .addResource("status")
      .addMethod("GET", new apigw.LambdaIntegration(githubOAuthFn));
    // EventBridge (Daily Scheduler) - triggers periodic checks (every 30 min)
    const schedulerRule = new events.Rule(this, "PeriodicSchedulerRule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
      description:
        "Triggers periodic checks every 30 min to determine which users need summaries generated.",
    });

    // SQS Queue (Ingestion) - buffers ingestion jobs
    const ingestionQueue = new sqs.Queue(this, "IngestionQueue", {
      queueName: "IngestionQueue",
      visibilityTimeout: cdk.Duration.seconds(300),
    });

    // SQS Queue (Summary) - buffers summary generation jobs
    const summaryQueue = new sqs.Queue(this, "SummaryQueue", {
      queueName: "SummaryQueue",
      visibilityTimeout: cdk.Duration.seconds(300),
    });

    // Target lambda for the scheduler
    const schedulerLambda = new lambda.Function(this, "SchedulerLambda", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/scheduler-lambda"),
      ),
      environment: {
        ...defaultEnvironment,
        INGESTION_QUEUE_URL: ingestionQueue.queueUrl,
      },
    });

    schedulerRule.addTarget(new targets.LambdaFunction(schedulerLambda));

    // Grant scheduler permission to send messages to Ingestion Queue
    ingestionQueue.grantSendMessages(schedulerLambda);

    // Ingestion Lambda
    const ingestionLambda = new lambda.Function(this, "IngestionLambda", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/ingestion-lambda"),
      ),
      timeout: cdk.Duration.seconds(300),
      environment: {
        ...defaultEnvironment,
        SUMMARY_QUEUE_URL: summaryQueue.queueUrl,
      },
    });

    // Add SQS event source for Ingestion Lambda
    ingestionLambda.addEventSource(new SqsEventSource(ingestionQueue));

    // Grant Ingestion Lambda permission to send messages to Summary Queue
    summaryQueue.grantSendMessages(ingestionLambda);
    // Summary Lambda
    const summaryLambda = new lambda.Function(this, "SummaryLambda", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/summary-lambda"),
      ),
      timeout: cdk.Duration.seconds(300),
      environment: {
        ...defaultEnvironment,
      },
    });

    // Add SQS event source for Summary Lambda
    summaryLambda.addEventSource(new SqsEventSource(summaryQueue));

    // Grant Summary Lambda permissions to invoke Bedrock
    summaryLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
      }),
    );

    // Create User Config Lambda
    const createUserConfigLambda = new lambdaNode.NodejsFunction(
      this,
      "CreateUserConfigLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/create-user-config-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(300),
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
        environment: {
          ...defaultEnvironment,
        },
      },
    );

    // API Gateway integration for CreateUserConfigLambda
    const userConfigResource = endpoint.root.addResource("user-config");
    userConfigResource.addMethod(
      "POST",
      new apigw.LambdaIntegration(createUserConfigLambda),
    );
    userConfigResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(createUserConfigLambda),
    );

    // Create Integration Connection Lambda
    const createIntegrationConnectionLambda = new lambdaNode.NodejsFunction(
      this,
      "CreateIntegrationConnectionLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/create-integration-connection-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(300),
        environment: {
          ...defaultEnvironment,
        },
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
      },
    );

    // API Gateway integration for CreateIntegrationConnectionLambda
    const integrationConnectionResource = endpoint.root.addResource("integration-connection");
    integrationConnectionResource.addMethod(
      "POST",
      new apigw.LambdaIntegration(createIntegrationConnectionLambda),
    );
    integrationConnectionResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(createIntegrationConnectionLambda),
    );


    // Outputs
    new cdk.CfnOutput(this, "BackendApiUrl", { value: endpoint.url });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "IngestionQueueUrl", {
      value: ingestionQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "SummaryQueueUrl", {
      value: summaryQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "SchedulerLambdaArn", {
      value: schedulerLambda.functionArn,
    });
    new cdk.CfnOutput(this, "IngestionLambdaArn", {
      value: ingestionLambda.functionArn,
    });
    new cdk.CfnOutput(this, "SummaryLambdaArn", {
      value: summaryLambda.functionArn,
    });
    new cdk.CfnOutput(this, "SlackIntegrationLambdaArn", {
      value: slackFn.functionArn,
    });
    new cdk.CfnOutput(this, "SlackOAuthInitiateArn", {
      value: slackOAuthInitiateFn.functionArn,
    });
    new cdk.CfnOutput(this, "SlackOAuthCallbackArn", {
      value: slackOAuthCallbackFn.functionArn,
    });
  }
}
