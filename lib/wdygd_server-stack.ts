import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
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

    // Fetch Credentials from Secrets Manager
    const appSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppSecret",
      "prod/wdygd",
    );

    const supabaseEnv = {
      SUPABASE_URL: appSecret
        .secretValueFromJson("SUPABASE_URL")
        .unsafeUnwrap(),
      SUPABASE_KEY: appSecret
        .secretValueFromJson("SUPABASE_KEY")
        .unsafeUnwrap(),
    };

    const postConfirmationLambda = new lambdaNode.NodejsFunction(
      this,
      "PostConfirmationLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/cognito-post-confirmation-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(30),
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
        environment: {
          ...supabaseEnv,
        },
      },
    );

    if (!existingUserPoolId) {
      (userPool as cognito.UserPool).addTrigger(
        cognito.UserPoolOperation.POST_CONFIRMATION,
        postConfirmationLambda,
      );
    }

    const githubOAuthEnv = {
      GITHUB_CLIENT_ID: appSecret
        .secretValueFromJson("GITHUB_CLIENT_ID")
        .unsafeUnwrap(),
      GITHUB_CLIENT_SECRET: appSecret
        .secretValueFromJson("GITHUB_CLIENT_SECRET")
        .unsafeUnwrap(),
      GITHUB_REDIRECT_URI: appSecret
        .secretValueFromJson("GITHUB_REDIRECT_URI")
        .unsafeUnwrap(),
    };

    const slackOAuthEnv = {
      SLACK_CLIENT_ID: appSecret
        .secretValueFromJson("SLACK_CLIENT_ID")
        .unsafeUnwrap(),
      SLACK_CLIENT_SECRET: appSecret
        .secretValueFromJson("SLACK_CLIENT_SECRET")
        .unsafeUnwrap(),
      SLACK_REDIRECT_URI: appSecret
        .secretValueFromJson("SLACK_REDIRECT_URI")
        .unsafeUnwrap(),
      STATE_SECRET: appSecret
        .secretValueFromJson("STATE_SECRET")
        .unsafeUnwrap(),
    };

    const fn = new lambdaNode.NodejsFunction(this, "BackendApiFn", {
      entry: path.join(
        __dirname,
        "..",
        "functions/backend-entry-lambda/index.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_LATEST,
      bundling: {
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        USER_POOL_ID: userPool.userPoolId,
      },
    });

    const githubFn = new lambdaNode.NodejsFunction(
      this,
      "GitHubIntegrationFn",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/integrations/github/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(300),
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
        environment: {
          ...supabaseEnv,
        },
      },
    );

    const githubOAuthFn = new lambdaNode.NodejsFunction(this, "GitHubOAuthFn", {
      entry: path.join(
        __dirname,
        "..",
        "functions/integrations/github/oauth.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_LATEST,
      timeout: cdk.Duration.seconds(30),
      bundling: {
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        ...supabaseEnv,
        ...githubOAuthEnv,
      },
    });

    const endpoint = new apigw.RestApi(this, "BackendApiGwEndpoint", {
      restApiName: "BackendApi",
      defaultIntegration: new apigw.LambdaIntegration(fn),
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(
      this,
      "WdygdAuthorizer",
      {
        cognitoUserPools: [userPool],
      },
    );

    // Add catch-all routes to mimic previous LambdaRestApi behavior
    endpoint.root.addMethod("ANY");
    const proxyResource = endpoint.root.addResource("{proxy+}");
    proxyResource.addMethod("ANY");

    // --- Slack OAuth ---
    const slackOAuthFn = new lambdaNode.NodejsFunction(this, "SlackOAuthFn", {
      entry: path.join(
        __dirname,
        "..",
        "functions/integrations/slack/oauth.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_LATEST,
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...supabaseEnv,
        ...slackOAuthEnv,
      },
      bundling: {
        externalModules: ["@aws-sdk/*"],
      },
    });

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
        ...supabaseEnv,
      },
    });

    const commonCorsOptions: apigw.CorsOptions = {
      allowOrigins: apigw.Cors.ALL_ORIGINS,
      allowMethods: apigw.Cors.ALL_METHODS,
      allowHeaders: ["Content-Type", "Authorization"],
    };

    const auth = endpoint.root.addResource("auth");

    // GitHub Auth routes
    const authGithub = auth.addResource("github", {
      defaultCorsPreflightOptions: commonCorsOptions,
    });
    authGithub.addMethod("GET", new apigw.LambdaIntegration(githubOAuthFn));
    authGithub.addMethod("DELETE", new apigw.LambdaIntegration(githubOAuthFn));
    authGithub
      .addResource("callback")
      .addMethod("GET", new apigw.LambdaIntegration(githubOAuthFn));
    authGithub
      .addResource("status")
      .addMethod("GET", new apigw.LambdaIntegration(githubOAuthFn));

    // Slack Auth routes
    const authSlack = auth.addResource("slack", {
      defaultCorsPreflightOptions: commonCorsOptions,
    });
    authSlack.addMethod("GET", new apigw.LambdaIntegration(slackOAuthFn));
    authSlack.addMethod("DELETE", new apigw.LambdaIntegration(slackOAuthFn));
    authSlack
      .addResource("callback")
      .addMethod("GET", new apigw.LambdaIntegration(slackOAuthFn));
    authSlack
      .addResource("status")
      .addMethod("GET", new apigw.LambdaIntegration(slackOAuthFn));

    // EventBridge (Daily Scheduler) - triggers periodic checks (every 1 hour)
    const schedulerRule = new events.Rule(this, "PeriodicSchedulerRule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description:
        "Triggers periodic checks every 1 hour to determine which users need summaries generated.",
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
    const schedulerLambda = new lambdaNode.NodejsFunction(
      this,
      "SchedulerLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/scheduler-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(300),
        environment: {
          ...supabaseEnv,
          INGESTION_QUEUE_URL: ingestionQueue.queueUrl,
        },
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
      },
    );

    schedulerRule.addTarget(new targets.LambdaFunction(schedulerLambda));

    // Grant scheduler permission to send messages to Ingestion Queue
    ingestionQueue.grantSendMessages(schedulerLambda);

    // Ingestion Lambda
    const ingestionLambda = new lambdaNode.NodejsFunction(
      this,
      "IngestionLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/ingestion-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(300),
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
        environment: {
          ...supabaseEnv,
          GITHUB_CLIENT_ID: githubOAuthEnv.GITHUB_CLIENT_ID,
          GITHUB_CLIENT_SECRET: githubOAuthEnv.GITHUB_CLIENT_SECRET,
          SLACK_CLIENT_ID: slackOAuthEnv.SLACK_CLIENT_ID,
          SLACK_CLIENT_SECRET: slackOAuthEnv.SLACK_CLIENT_SECRET,
          SUMMARY_QUEUE_URL: summaryQueue.queueUrl,
          GITHUB_LAMBDA_ARN: githubFn.functionArn,
          SLACK_LAMBDA_ARN: slackFn.functionArn,
        },
      },
    );

    // Grant Ingestion Lambda permission to invoke the integration lambdas
    githubFn.grantInvoke(ingestionLambda);
    slackFn.grantInvoke(ingestionLambda);

    // Add SQS event source for Ingestion Lambda
    ingestionLambda.addEventSource(new SqsEventSource(ingestionQueue));

    // Grant Ingestion Lambda permission to send messages to Summary Queue
    summaryQueue.grantSendMessages(ingestionLambda);
    // Summary Lambda
    const summaryLambda = new lambdaNode.NodejsFunction(this, "SummaryLambda", {
      entry: path.join(__dirname, "..", "functions/summary-lambda/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_LATEST,
      timeout: cdk.Duration.seconds(300),
      bundling: {
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        ...supabaseEnv,
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

    // Get User Config Lambda
    const getUserConfigLambda = new lambdaNode.NodejsFunction(
      this,
      "GetUserConfigLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/get-user-config-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(300),
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
        environment: {
          ...supabaseEnv,
        },
      },
    );

    // API Gateway integration for GetUserConfigLambda
    const userConfigResource = endpoint.root.addResource("user-config", {
      defaultCorsPreflightOptions: commonCorsOptions,
    });
    userConfigResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(getUserConfigLambda),
      {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
    );

    // Get Integration Connections Lambda
    const getIntegrationConnectionsLambda = new lambdaNode.NodejsFunction(
      this,
      "GetIntegrationConnectionsLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/get-integration-connections-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(300),
        environment: {
          ...supabaseEnv,
        },
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
      },
    );

    // API Gateway integration for GetIntegrationConnectionsLambda
    const integrationConnectionResource = endpoint.root.addResource(
      "integration-connection",
      {
        defaultCorsPreflightOptions: commonCorsOptions,
      },
    );
    integrationConnectionResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(getIntegrationConnectionsLambda),
      {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
    );

    // Ingestion API Lambda
    const ingestionApiLambda = new lambdaNode.NodejsFunction(
      this,
      "IngestionApiLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/ingestion-api-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(30),
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
        environment: {
          INGESTION_QUEUE_URL: ingestionQueue.queueUrl,
        },
      },
    );

    ingestionQueue.grantSendMessages(ingestionApiLambda);

    // Summary API Lambda
    const summaryApiLambda = new lambdaNode.NodejsFunction(
      this,
      "SummaryApiLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "functions/summary-api-lambda/index.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_LATEST,
        timeout: cdk.Duration.seconds(30),
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
        environment: {
          ...supabaseEnv,
          SUMMARY_QUEUE_URL: summaryQueue.queueUrl,
        },
      },
    );

    summaryQueue.grantSendMessages(summaryApiLambda);

    const summaryResource = endpoint.root.addResource("summary", {
      defaultCorsPreflightOptions: commonCorsOptions,
    });
    summaryResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(summaryApiLambda),
      {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
    );
    summaryResource.addMethod(
      "POST",
      new apigw.LambdaIntegration(summaryApiLambda),
      {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
    );

    // Sync API Integration
    const syncResource = endpoint.root.addResource("sync", {
      defaultCorsPreflightOptions: commonCorsOptions,
    });
    syncResource.addMethod(
      "POST",
      new apigw.LambdaIntegration(ingestionApiLambda),
      {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
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
    new cdk.CfnOutput(this, "SummaryApiLambdaArn", {
      value: summaryApiLambda.functionArn,
    });
    new cdk.CfnOutput(this, "SlackIntegrationLambdaArn", {
      value: slackFn.functionArn,
    });
    new cdk.CfnOutput(this, "SlackOAuthArn", {
      value: slackOAuthFn.functionArn,
    });
    new cdk.CfnOutput(this, "GitHubIntegrationLambdaArn", {
      value: githubFn.functionArn,
    });
    new cdk.CfnOutput(this, "GitHubOAuthArn", {
      value: githubOAuthFn.functionArn,
    });
  }
}
