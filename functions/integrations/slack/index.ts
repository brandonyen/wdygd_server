import { WebClient } from "@slack/web-api";

interface SlackEvent {
  channelId: string;
  startDate: string;
  endDate: string;
  accessToken: string;
  targetUserId: string;
}

interface MessageInfo {
  user: string;
  text: string;
  timestamp: string;
  threadReplies: { user: string; text: string; timestamp: string }[];
}


// need to remove accessToken from logs and error messages to avoid leaking it
export const handler = async (event: SlackEvent) => {
  const { channelId, startDate, endDate, accessToken } = event;

  if (!accessToken) {
    throw new Error("Missing accessToken in event payload");
  }

  const client = new WebClient(accessToken);
  const oldest = (new Date(startDate).getTime() / 1000).toString();
  const latest = (new Date(endDate).getTime() / 1000).toString();

  const messages: MessageInfo[] = [];
  const userIds = new Set<string>();
  let cursor: string | undefined;

  try {
    do {
      const result = await client.conversations.history({
        channel: channelId,
        oldest,
        latest,
        limit: 100,
        cursor,
      });

      for (const msg of result.messages ?? []) {
        if (msg.user) userIds.add(msg.user);

        const threadReplies: MessageInfo["threadReplies"] = [];

        if (msg.reply_count && msg.reply_count > 0 && msg.ts) {
          let replyCursor: string | undefined;

          do {
            try {
              const threadResult = await client.conversations.replies({
                channel: channelId,
                ts: msg.ts,
                limit: 100,
                cursor: replyCursor,
              });

              for (const reply of threadResult.messages ?? []) {
                if (reply.ts === msg.ts) continue; // skip parent message
                if (reply.user) userIds.add(reply.user);
                threadReplies.push({
                  user: reply.user ?? "unknown",
                  text: reply.text ?? "",
                  timestamp: reply.ts ?? "",
                });
              }

              replyCursor = threadResult.response_metadata?.next_cursor || undefined;
            } catch (e) {
              console.warn(`Skipping remaining thread ${msg.ts} due to error`, e);
              break;
            }
          } while (replyCursor);
        }

        messages.push({
          user: msg.user ?? "unknown",
          text: msg.text ?? "",
          timestamp: msg.ts ?? "",
          threadReplies,
        });
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Batch user lookups in parallel chunks of 5
    const uniqueUsers = Array.from(userIds);
    const userMap: Record<string, string> = {};

    for (let i = 0; i < uniqueUsers.length; i += 5) {
      const chunk = uniqueUsers.slice(i, i + 5);
      await Promise.all(
        chunk.map(async (uid) => {
          try {
            const info = await client.users.info({ user: uid });
            userMap[uid] =
              info.user?.real_name ?? info.user?.name ?? uid;
          } catch {
            userMap[uid] = "Unknown User";
          }
        }),
      );
    }

    const enrichedMessages = messages.map((msg) => ({
      ...msg,
      user: userMap[msg.user] ?? msg.user,
      threadReplies: msg.threadReplies.map((reply) => ({
        ...reply,
        user: userMap[reply.user] ?? reply.user,
      })),
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        channelId,
        dateRange: { start: startDate, end: endDate },
        messages: enrichedMessages,
      }),
    };
  } catch (error) {
    console.error("Slack Handler Failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch Slack messages" }),
    };
  }
};
