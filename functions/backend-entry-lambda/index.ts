import type { APIGatewayProxyEvent } from "aws-lambda";

export const handler = async (event: APIGatewayProxyEvent) => {
  console.log(
    `Backend entry lambda triggered with method: ${event.httpMethod}, path: ${event.path}`,
  );
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      status: "Healthy",
      timestamp: new Date().toISOString(),
    }),
  };
};
