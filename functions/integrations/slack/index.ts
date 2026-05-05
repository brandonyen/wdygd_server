import { WebClient } from "@slack/web-api";
import { getSupabase } from "../../utils/get-supabase-client";

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

async function refreshSlackToken(refreshToken: string) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Slack credentials for token refresh");
  }

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = (await response.json()) as any;
  if (!data.ok) {
    throw new Error(`Slack token refresh failed: ${data.error}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token, // might be unchanged or new
    expires_in: data.expires_in, // in seconds
  };
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

            replyCursor =
              threadResult.response_metadata?.next_cursor || undefined;
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

export const handler = async (event: any) => {
  console.log(
    `Slack integration lambda triggered with event:`,
    JSON.stringify(event),
  );
  const { startDate, endDate, userId, integrationId } = event;

  const supabase = await getSupabase();

  // Fetch access token from IntegrationConnection table
  const { data: integrationData, error: integrationError } = await (
    supabase as any
  )
    .from("IntegrationConnection")
    .select("access_token, refresh_token, token_expiration")
    .eq("integration_id", integrationId)
    .eq("user_id", userId)
    .single();

  const integration = integrationData as any;

  if (integrationError || !integration?.access_token) {
    throw new Error(
      `Failed to fetch integration credentials: ${integrationError?.message}`,
    );
  }

  let accessToken = integration.access_token;

  if (
    integration.token_expiration &&
    new Date(integration.token_expiration) <= new Date()
  ) {
    console.log("Slack token expired, attempting refresh...");

    if (!integration.refresh_token) {
      throw new Error("Slack token expired and no refresh token available.");
    }

    const refreshResult = await refreshSlackToken(integration.refresh_token);
    accessToken = refreshResult.access_token;

    const newExpiration = refreshResult.expires_in
      ? new Date(Date.now() + refreshResult.expires_in * 1000).toISOString()
      : null;

    // Update DB with new token
    const { error: updateError } = await (supabase as any)
      .from("IntegrationConnection")
      .update({
        access_token: refreshResult.access_token,
        refresh_token: refreshResult.refresh_token,
        token_expiration: newExpiration,
      })
      .eq("integration_id", integrationId);

    if (updateError) {
      console.error(
        "Failed to update IntegrationConnection with refreshed Slack token:",
        updateError,
      );
    } else {
      console.log("Successfully refreshed and updated Slack token.");
    }
  }

  const client = new WebClient(accessToken);

  // Get the Slack user ID associated with this token
  const authInfo = await client.auth.test();
  const targetUserId = authInfo.user_id;

  if (!targetUserId) {
    throw new Error("Failed to resolve Slack user ID from access token");
  }

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

    // Write one ActivityEvent per channel to Supabase
    const now = new Date().toISOString();
    const activityEvents = enrichedChannels.map((channel) => ({
      user_id: userId,
      integration_id: integrationId,
      timestamp: now,
      payload: {
        dateRange: { start: startDate, end: endDate },
        channelId: channel.channelId,
        channelName: channel.channelName,
        messages: channel.messages,
      },
    }));

    if (activityEvents.length > 0) {
      const { error: insertError } = await (supabase as any)
        .from("ActivityEvent")
        .insert(activityEvents);

      if (insertError) {
        console.error("Failed to write activity events to DB:", insertError);
        throw new Error(`DB insert failed: ${insertError.message}`);
      }

      console.log(`Wrote ${activityEvents.length} activity events to DB`);
    } else {
      console.log(
        "No activity events to write (user had no messages in range)",
      );
    }

    return {
      dateRange: { start: startDate, end: endDate },
      channels: enrichedChannels,
    };
  } catch (error) {
    console.error("Slack Handler Failed:", error);
    throw error;
  }
};
