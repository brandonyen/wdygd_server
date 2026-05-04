import { generateSummary } from "../utils/generate-summary";

// ============================================================================
// Main Handler
// ============================================================================

export const handler = async (event: any) => {
  console.log(
    "Summary generation triggered with records:",
    event.Records?.length || 1,
  );

  for (const record of event.Records) {
    let payload;
    try {
      payload = JSON.parse(record.body);
    } catch (e) {
      console.error("Failed to parse SQS record body:", record.body);
      continue;
    }

    const { user_id, start_date, end_date, summary_type } = payload;
    if (!user_id || !start_date || !end_date || !summary_type) {
      console.error("Missing required fields in payload:", payload);
      continue;
    }

    console.log(
      `Generating summary for user ${user_id} (${start_date} to ${end_date})`,
    );

    try {
      await generateSummary(user_id, start_date, end_date, summary_type);
    } catch (err) {
      console.error(`Error processing summary for user ${user_id}:`, err);
    }
  }
};
