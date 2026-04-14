exports.handler = async (event: any) => {
  console.log("Ingestion triggered with records:", event.Records.length);

  for (const record of event.Records) {
    const payload = JSON.parse(record.body);
    console.log("Processing ingestion for user:", payload.userId);
    // 1. Fetch data from Supabase (User Config DB) for integration tokens
    // 2. Fetch data from Github, Linear, Slack, etc.
    // 3. Normalize to raw text
    // 4. Save to Supabase (Activity DB)
    // 5. Send message to SummaryQueue indicating data is ready for summarization
  }
};
