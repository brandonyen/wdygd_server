import { getSupabase } from "../utils/get-supabase-client";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqsClient = new SQSClient({});

interface UserConfig {
  user_id: string;
  email: string;
  created_at: string;
  last_sync: string;
}

exports.handler = async (event: any) => {
  console.log("Scheduler triggered to check for users needing summaries.");

  try {
    const supabase = await getSupabase();
    
    // Calculate the time 24 hours ago
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    const oneDayAgoISO = oneDayAgo.toISOString();

    console.log(`Checking for users with last_sync before ${oneDayAgoISO}`);

    // Query users where last_sync < oneDayAgo
    const { data, error: fetchError } = await supabase
      .from("UserConfig")
      .select("*")
      .lt("last_sync", oneDayAgoISO);

    if (fetchError) {
      console.error("Error fetching users from Supabase:", fetchError);
      return;
    }

    const users = data as UserConfig[] | null;

    if (!users || users.length === 0) {
      console.log("No users need summaries at this time.");
      return;
    }

    console.log(`Found ${users.length} users needing summaries.`);

    const queueUrl = process.env.INGESTION_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("INGESTION_QUEUE_URL environment variable is not set");
    }

    // Process each user
    for (const user of users) {
      console.log(`Queueing user ${user.email} (ID: ${user.user_id}) for ingestion.`);

      // Send to SQS
      const messageBody = JSON.stringify({
        userId: user.user_id,
        timestamp: new Date().toISOString()
      });

      const sendCommand = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: messageBody,
      });

      await sqsClient.send(sendCommand);

      // Update last_sync timestamp
      // Cast the chain as any to bypass strict type requirements if necessary
      const nowISO = new Date().toISOString();
      const { error: updateError } = await (supabase.from("UserConfig") as any)
        .update({ last_sync: nowISO })
        .eq("user_id", user.user_id);

      if (updateError) {
        console.error(`Failed to update last_sync for user ${user.email}:`, updateError);
      } else {
        console.log(`Successfully updated last_sync for user ${user.email} to ${nowISO}`);
      }
    }

    console.log("Scheduler finished processing users.");
  } catch (error) {
    console.error("Unexpected error in scheduler lambda:", error);
    throw error; // Re-throw to indicate lambda failure
  }
};
