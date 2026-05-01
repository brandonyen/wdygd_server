import { getSupabase } from "../utils/get-supabase-client";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({});

export const handler = async (event: any) => {
  console.log(
    "Summary generation triggered with records:",
    event.Records?.length || 1,
  );
  const supabase = await getSupabase();

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
      // 0. Check if summary already exists
      const { data: existingSummaries, error: checkError } = await (
        supabase.from("Summary") as any
      )
        .select("summary_id")
        .eq("user_id", user_id)
        .eq("start_date", start_date)
        .eq("end_date", end_date)
        .eq("summary_type", summary_type);

      if (checkError) {
        throw new Error(
          `Failed to check existing summaries: ${checkError.message}`,
        );
      }

      if (existingSummaries && existingSummaries.length > 0) {
        console.log(
          `Summary already exists for user ${user_id} (${start_date} to ${end_date}) type ${summary_type}. Skipping.`,
        );
        continue;
      }

      // 1. Fetch Integrations to map integration_id -> provider
      const { data: integrations, error: intError } = await supabase
        .from("IntegrationConnection")
        .select("integration_id, provider")
        .eq("user_id", user_id);

      if (intError) {
        throw new Error(`Failed to fetch integrations: ${intError.message}`);
      }

      const providerMap = new Map<string, string>();
      for (const intg of (integrations as any[]) || []) {
        providerMap.set(intg.integration_id, intg.provider);
      }

      // 2. Fetch ActivityEvents using pagination
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;

      const slackChannels = new Map<
        string,
        {
          name: string;
          messagesCount: number;
          participants: Set<string>;
          snippets: string[];
        }
      >();
      const githubStats = {
        commits: 0,
        prsOpened: 0,
        prsMerged: 0,
        issuesClosed: 0,
        repos: new Set<string>(),
      };

      let totalEventsProcessed = 0;

      while (hasMore) {
        const { data, error } = await supabase
          .from("ActivityEvent")
          .select("*")
          .eq("user_id", user_id)
          .gte("timestamp", start_date)
          .lte("timestamp", end_date)
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (error) {
          throw new Error(`Failed to fetch ActivityEvents: ${error.message}`);
        }

        if (!data || data.length === 0) {
          hasMore = false;
          break;
        }

        for (const ev of data as any[]) {
          totalEventsProcessed++;
          const provider = providerMap.get(ev.integration_id);
          const p = ev.payload;

          if (!p) continue;

          if (provider === "SLACK") {
            const channelId = p.channelId;
            if (channelId) {
              if (!slackChannels.has(channelId)) {
                slackChannels.set(channelId, {
                  name: p.channelName || "unknown",
                  messagesCount: 0,
                  participants: new Set(),
                  snippets: [],
                });
              }
              const ch = slackChannels.get(channelId)!;
              const messages = p.messages || [];
              ch.messagesCount += messages.length;
              for (const msg of messages) {
                if (msg.user) ch.participants.add(msg.user);
                // Extract a few sample snippets for context
                if (ch.snippets.length < 5 && msg.text) {
                  ch.snippets.push(
                    `${msg.user}: ${msg.text.substring(0, 150)}`,
                  );
                }
              }
            }
          } else if (provider === "GITHUB") {
            if (p.repository) {
              githubStats.repos.add(
                `${p.repository.owner}/${p.repository.repo}`,
              );
            }
            if (p.stats) {
              githubStats.commits += p.stats.totalCommits || 0;
              githubStats.prsOpened += p.stats.totalPRsOpened || 0;
              githubStats.prsMerged += p.stats.totalPRsMerged || 0;
              githubStats.issuesClosed += p.stats.totalIssuesClosed || 0;
            }
          }
        }

        if (data.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }
      }

      console.log(
        `Aggregated ${totalEventsProcessed} events for user ${user_id}`,
      );

      if (totalEventsProcessed === 0) {
        console.log("No activity events found, skipping summary generation.");
        continue;
      }

      // 3. Build Prompt Template
      let prompt = `You are an AI assistant. Generate a professional and concise daily summary of work activities based on the following aggregated data.\n\n`;

      if (githubStats.repos.size > 0) {
        prompt += `GitHub Activity:\n- Repositories touched: ${Array.from(githubStats.repos).join(", ")}\n- Commits made: ${githubStats.commits}\n- Pull Requests Opened: ${githubStats.prsOpened}\n- Pull Requests Merged: ${githubStats.prsMerged}\n- Issues Closed: ${githubStats.issuesClosed}\n\n`;
      }

      if (slackChannels.size > 0) {
        prompt += `Slack Activity:\n`;
        for (const [_, ch] of slackChannels.entries()) {
          prompt += `- Channel #${ch.name}: ${ch.messagesCount} messages involving ${Array.from(ch.participants).join(", ")}.\n`;
          if (ch.snippets.length > 0) {
            prompt += `  Sample conversations:\n    ${ch.snippets.join("\n    ")}\n`;
          }
        }
      }

      prompt += `\nPlease provide a concise, natural-language summary (1-2 paragraphs) detailing what was accomplished, reviewed, or discussed today. Do not hallucinate information not present in the data.`;

      // 4. Call Bedrock
      const bedrockReq = {
        modelId: "anthropic.claude-3-haiku-20240307-v1:0", // Using fast/cost-effective Claude 3 Haiku
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      };

      const bedrockResponse = await bedrockClient.send(
        new InvokeModelCommand(bedrockReq),
      );
      const result = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
      const summaryText = result.content[0].text;

      // 5. Write to Summary table
      // Note: Cast chain to 'any' to bypass strict schema types if not defined perfectly
      const { error: insertError } = await (
        supabase.from("Summary") as any
      ).insert({
        user_id: user_id,
        summary_type: summary_type,
        created_at: new Date().toISOString(),
        start_date: start_date,
        end_date: end_date,
        content: summaryText,
      });

      if (insertError) {
        throw new Error(
          `Failed to write summary to DB: ${insertError.message}`,
        );
      }

      console.log(
        `Successfully generated and saved summary for user ${user_id}`,
      );
    } catch (err) {
      console.error(`Error processing summary for user ${user_id}:`, err);
    }
  }
};
