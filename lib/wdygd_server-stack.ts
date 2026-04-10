import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cognito from "aws-cdk-lib/aws-cognito";
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

    // Environment Variables (Supabase credentials)
    const defaultEnvironment = {
      SUPABASE_URL: process.env.SUPABASE_URL || "PLACEHOLDER_URL",
      SUPABASE_KEY: process.env.SUPABASE_KEY || "PLACEHOLDER_KEY",
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

    const endpoint = new apigw.LambdaRestApi(this, `BackendApiGwEndpoint`, {
      handler: fn,
      restApiName: `BackendApi`,
      proxy: false,
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    endpoint.root.addProxy({ anyMethod: true });

    const github = endpoint.root.addResource("github");
    github.addMethod("POST", new apigw.LambdaIntegration(githubFn));

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

    // Outputs
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
    new cdk.CfnOutput(this, "GitHubApiEndpoint", {
      value: `${endpoint.url}github`,
    });
  }
}
