import { WebClient } from "@slack/web-api";

interface SlackEvent {
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

interface ChannelMessages {
  channelId: string;
  channelName: string;
  messages: MessageInfo[];
}

async function fetchChannelMessages(
  client: WebClient,
  channelId: string,
  oldest: string,
  latest: string,
  userIds: Set<string>,
): Promise<MessageInfo[]> {
  const messages: MessageInfo[] = [];
  let cursor: string | undefined;

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

  return messages;
}

// need to remove accessToken from logs and error messages to avoid leaking it
export const handler = async (event: SlackEvent) => {
  const { startDate, endDate, accessToken, targetUserId } = event;

  if (!accessToken) {
    throw new Error("Missing accessToken in event payload");
  }

  const client = new WebClient(accessToken);
  const oldest = (new Date(startDate).getTime() / 1000).toString();
  const latest = (new Date(endDate).getTime() / 1000).toString();

  const userIds = new Set<string>();
  const channelResults: ChannelMessages[] = [];

  try {
    // Fetch all channels the user is a member of
    let channelCursor: string | undefined;
    const channels: { id: string; name: string }[] = [];

    do {
      const result = await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor: channelCursor,
      });

      for (const channel of result.channels ?? []) {
        if (channel.id && channel.name && channel.is_member) {
          channels.push({ id: channel.id, name: channel.name });
        }
      }

      channelCursor = result.response_metadata?.next_cursor || undefined;
    } while (channelCursor);

    console.log(`Found ${channels.length} channels, fetching messages...`);

    // Fetch messages for each channel and filter to channels where targetUserId spoke
    for (const channel of channels) {
      try {
        const messages = await fetchChannelMessages(
          client,
          channel.id,
          oldest,
          latest,
          userIds,
        );

        const userSpoke = messages.some(
          (msg) =>
            msg.user === targetUserId ||
            msg.threadReplies.some((reply) => reply.user === targetUserId),
        );

        if (userSpoke) {
          channelResults.push({
            channelId: channel.id,
            channelName: channel.name,
            messages,
          });
        }
      } catch (e) {
        console.warn(`Skipping channel ${channel.name} due to error`, e);
      }
    }

    // Resolve all user IDs to real names
    const userMap: Record<string, string> = {};

    for (const uid of userIds) {
      try {
        const info = await client.users.info({ user: uid });
        userMap[uid] = info.user?.real_name ?? info.user?.name ?? uid;
      } catch {
        userMap[uid] = "Unknown User";
      }
    }

    const enrichedChannels = channelResults.map((channel) => ({
      ...channel,
      messages: channel.messages.map((msg) => ({
        ...msg,
        user: userMap[msg.user] ?? msg.user,
        threadReplies: msg.threadReplies.map((reply) => ({
          ...reply,
          user: userMap[reply.user] ?? reply.user,
        })),
      })),
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        dateRange: { start: startDate, end: endDate },
        channels: enrichedChannels,
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
