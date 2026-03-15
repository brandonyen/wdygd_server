import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as path from "node:path";

export class WdygdServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const fn = new lambda.Function(this, "BackendApiFn", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/backend-entry-lambda"),
      ),
    });

    const endpoint = new apigw.LambdaRestApi(this, `BackendApiGwEndpoint`, {
      handler: fn,
      restApiName: `BackendApi`,
    });

    // EventBridge (Daily Scheduler) - triggers periodic checks (every 30 min)
    const schedulerRule = new events.Rule(this, "PeriodicSchedulerRule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
      description:
        "Triggers periodic checks every 30 min to determine which users need summaries generated.",
    });

    // Target lambda for the scheduler
    const schedulerLambda = new lambda.Function(this, "SchedulerLambda", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/scheduler-lambda"),
      ),
    });

    schedulerRule.addTarget(new targets.LambdaFunction(schedulerLambda));

    // Summary Lambda
    const summaryLambda = new lambda.Function(this, "SummaryLambda", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions/summary-lambda"),
      ),
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
  }
}
