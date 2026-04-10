import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
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
  }
}
