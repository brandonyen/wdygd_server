import { config } from "dotenv";
import { resolve } from "path";
import { handler } from "./index.js";
import type { APIGatewayProxyEvent } from "aws-lambda";

// Load .env from project root
config({ path: resolve(__dirname, "../../../.env") });

async function testHandler() {
  // Get values from command line args or environment
  const owner = process.argv[2] || "facebook";
  const repo = process.argv[3] || "react";
  const daysOrStartDate = process.argv[4]; // e.g., "7" or "2024-03-01"
  const endDateArg = process.argv[5]; // e.g., "2024-03-07"
  const token = process.env.GITHUB_TOKEN;

  if (!token || token === "your_github_token_here") {
    console.error("Error: GITHUB_TOKEN not set in .env file");
    console.error("Update the .env file in the project root with your GitHub token");
    console.error("\nUsage: npx ts-node test-local.ts [owner] [repo] [days|startDate] [endDate]");
    console.error("Examples:");
    console.error("  npx ts-node test-local.ts facebook react           # last 7 days");
    console.error("  npx ts-node test-local.ts facebook react 30        # last 30 days");
    console.error("  npx ts-node test-local.ts facebook react 2024-03-01 2024-03-07  # custom range");
    process.exit(1);
  }

  let startDate: Date;
  let endDate: Date;

  if (endDateArg) {
    // Custom date range: startDate and endDate provided
    startDate = new Date(daysOrStartDate);
    endDate = new Date(endDateArg);
  } else if (daysOrStartDate && !isNaN(Number(daysOrStartDate))) {
    // Number of days provided
    endDate = new Date();
    startDate = new Date();
    startDate.setDate(startDate.getDate() - Number(daysOrStartDate));
  } else if (daysOrStartDate) {
    // Single date provided - use as start date, end is now
    startDate = new Date(daysOrStartDate);
    endDate = new Date();
  } else {
    // Default to last 7 days
    endDate = new Date();
    startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
  }

  const testEvent = {
    body: JSON.stringify({
      githubToken: token,
      owner,
      repo,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      includeIssues: true,
    }),
  } as APIGatewayProxyEvent;

  console.log(`Testing GitHub Lambda for ${owner}/${repo}...`);
  console.log(`Date range: ${startDate.toISOString()} to ${endDate.toISOString()}\n`);

  const result = await handler(testEvent);

  console.log("Status:", result.statusCode);
  console.log("Response:", JSON.stringify(JSON.parse(result.body), null, 2));
}

testHandler().catch(console.error);
