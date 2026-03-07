import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
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

    const slackFn = new lambdaNode.NodejsFunction(this, "SlackIntegrationFn", {
      entry: path.join(
        __dirname,
        "..",
        "functions/integrations/slack/index.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
    });
  }
}
