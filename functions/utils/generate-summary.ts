import { getSupabase } from "./get-supabase-client";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { checkExistingSummary } from "./check-existing-summary";

const bedrockClient = new BedrockRuntimeClient({});

interface ProviderAggregator {
  aggregate(payload: any): void;
  getPrompt(): string;
  getMetrics(): any;
}

class SlackAggregator implements ProviderAggregator {
  private slackChannels = new Map<
    string,
    {
      name: string;
      messagesCount: number;
      participants: Set<string>;
      snippets: string[];
    }
  >();

  aggregate(p: any): void {
    const channelId = p.channelId;
    if (!channelId) return;

    if (!this.slackChannels.has(channelId)) {
      this.slackChannels.set(channelId, {
        name: p.channelName || "unknown",
        messagesCount: 0,
        participants: new Set(),
        snippets: [],
      });
    }
    const ch = this.slackChannels.get(channelId)!;
    const messages = p.messages || [];
    ch.messagesCount += messages.length;
    for (const msg of messages) {
      if (msg.user) ch.participants.add(msg.user);
      if (ch.snippets.length < 5 && msg.text) {
        ch.snippets.push(`${msg.user}: ${msg.text.substring(0, 150)}`);
      }
    }
  }

  getPrompt(): string {
    if (this.slackChannels.size === 0) return "";

    let prompt = `Slack Activity:\n`;
    for (const [_, ch] of this.slackChannels.entries()) {
      prompt += `- Channel #${ch.name}: ${ch.messagesCount} messages involving ${Array.from(
        ch.participants,
      ).join(", ")}.\n`;
      if (ch.snippets.length > 0) {
        prompt += `  Sample conversations:\n    ${ch.snippets.join("\n    ")}\n`;
      }
    }
    return prompt + "\n";
  }

  getMetrics(): any {
    let totalMessagesCount = 0;
    for (const [_, ch] of this.slackChannels.entries()) {
      totalMessagesCount += ch.messagesCount;
    }
    return {
      totalMessagesCount,
      totalChannels: this.slackChannels.size,
    };
  }
}

class GitHubAggregator implements ProviderAggregator {
  private stats = {
    commits: 0,
    prsOpened: 0,
    prsMerged: 0,
    prsClosed: 0,
    totalReviews: 0,
    totalIssuesOpened: 0,
    totalIssuesClosed: 0,
    repos: new Set<string>(),
  };

  private commitMessages: string[] = [];
  private prDetails: { title: string; body: string; action: string }[] = [];

  aggregate(p: any): void {
    if (p.stats) {
      this.stats.commits += p.stats.commits || 0;
      this.stats.prsOpened += p.stats.prsOpened || 0;
      this.stats.prsMerged += p.stats.prsMerged || 0;
      this.stats.prsClosed += p.stats.prsClosed || 0;
      this.stats.totalReviews += p.stats.totalReviews || 0;
      this.stats.totalIssuesOpened += p.stats.totalIssuesOpened || 0;
      this.stats.totalIssuesClosed += p.stats.totalIssuesClosed || 0;
      if (p.stats.repos) {
        for (const repo of p.stats.repos) {
          this.stats.repos.add(repo);
        }
      }
    }
    if (p.commitMessages) {
      for (const msg of p.commitMessages) {
        if (this.commitMessages.length < 50) {
          this.commitMessages.push(msg);
        }
      }
    }
    if (p.prDetails) {
      for (const pr of p.prDetails) {
        if (this.prDetails.length < 10) {
          this.prDetails.push(pr);
        }
      }
    }
  }

  getPrompt(): string {
    if (this.stats.repos.size === 0) return "";

    let prompt = `GitHub Activity:
- Repositories touched: ${Array.from(this.stats.repos).join(", ")}
- Commits made: ${this.stats.commits}
- Pull Requests Opened: ${this.stats.prsOpened}
- Pull Requests Merged: ${this.stats.prsMerged}
- Pull Requests Closed (unmerged): ${this.stats.prsClosed}
- PR Reviews Submitted: ${this.stats.totalReviews}
- Issues Opened: ${this.stats.totalIssuesOpened}
- Issues Closed: ${this.stats.totalIssuesClosed}

`;

    if (this.prDetails.length > 0) {
      prompt += `Key Pull Requests:\n`;
      for (const pr of this.prDetails) {
        prompt += `- [${pr.action.toUpperCase()}] ${pr.title}\n`;
        if (pr.body) {
          prompt += `  Description: ${pr.body.substring(0, 200).replace(/\n/g, " ")}...\n`;
        }
      }
      prompt += `\n`;
    }

    if (this.commitMessages.length > 0) {
      prompt += `Sample Commits:\n`;
      for (const msg of this.commitMessages.slice(0, 50)) {
        prompt += `- ${msg}\n`;
      }
      prompt += `\n`;
    }

    return prompt;
  }

  getMetrics(): any {
    return {
      ...this.stats,
      repos: Array.from(this.stats.repos),
    };
  }
}

export async function generateSummary(
  user_id: string,
  start_date: string,
  end_date: string,
  summary_type: string,
): Promise<{ summary: any; skipped: boolean }> {
  console.log(
    `generateSummary called for user_id: ${user_id}, start_date: ${start_date}, end_date: ${end_date}, summary_type: ${summary_type}`,
  );
  const supabase = await getSupabase();

  // 0. Check if summary already exists
  const existingSummary = await checkExistingSummary(
    user_id,
    start_date,
    end_date,
    summary_type,
  );

  if (existingSummary) {
    console.log(
      `Summary already exists for user ${user_id} (${start_date} to ${end_date}) type ${summary_type}. Skipping.`,
    );
    return { summary: existingSummary, skipped: true };
  }

  // 1. Fetch Integrations
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

  // 2. Initialize Aggregators
  const aggregators = new Map<string, ProviderAggregator>();
  aggregators.set("SLACK", new SlackAggregator());
  aggregators.set("GITHUB", new GitHubAggregator());

  // 3. Fetch ActivityEvents using pagination
  let page = 0;
  const pageSize = 1000;
  let hasMore = true;
  let totalEventsProcessed = 0;

  while (hasMore) {
    const { data, error } = await supabase
      .from("ActivityEvent")
      .select("*")
      .eq("user_id", user_id)
      .gte("start_date", start_date)
      .lte("end_date", end_date)
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

      if (!p || !provider) continue;

      const aggregator = aggregators.get(provider);
      if (aggregator) {
        aggregator.aggregate(p);
      }
    }

    if (data.length < pageSize) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(`Aggregated ${totalEventsProcessed} events for user ${user_id}`);

  if (totalEventsProcessed === 0) {
    console.log("No activity events found, skipping summary generation.");
    throw new Error("No activity events found in the specified date range.");
  }

  // 4. Build Prompt Template
  const start = new Date(start_date);
  const end = new Date(end_date);
  const isMultiDay = (end.getTime() - start.getTime()) > (24 * 60 * 60 * 1000 + 1000); // 24h + small buffer

  let prompt = `You are an AI assistant. Generate a professional and concise summary of work activities based on the following aggregated data.\n\n`;

  for (const aggregator of aggregators.values()) {
    prompt += aggregator.getPrompt();
  }

  const timeFrameDesc = isMultiDay ? "the specified period" : "today";
  const avoidDailyPhrases = isMultiDay ? "Since this summary covers multiple days, do NOT use phrases like 'today's work', 'today I...', or 'accomplished today'. Instead, refer to the activities across the entire period." : "";
  const paragraphRequirement = isMultiDay ? "exactly 2 paragraphs, providing a more detailed and comprehensive breakdown" : "1-2 paragraphs";

  prompt += `\nPlease provide a concise summary detailing what was accomplished, reviewed, or discussed during ${timeFrameDesc}. Do not hallucinate information not present in the data. ${avoidDailyPhrases}

You must return your response as a valid JSON object with exactly four keys:
1. "content": A natural-language summary (${paragraphRequirement}) detailing the activities.
2. "content_array": An array of strings representing the same activities, but broken down into bullet points. Do NOT use first-person pronouns like "I" or "me" in this array. Start each point with an action verb in the past tense (e.g., "Focused on improving...", "Reviewed pull requests...").
3. "github_content_array": An array of strings representing ONLY the GitHub activities, broken down into bullet points. Start each point with an action verb in the past tense.
4. "slack_content_array": An array of strings representing ONLY the Slack activities, broken down into bullet points. Start each point with an action verb in the past tense.

Return ONLY valid JSON without any markdown formatting, backticks, or extra text.`;

  // 5. Call Bedrock with Converse API
  const bedrockCommand = new ConverseCommand({
    modelId: "qwen.qwen3-32b-v1:0",
    messages: [
      {
        role: "user",
        content: [{ text: prompt }],
      },
    ],
    inferenceConfig: {
      maxTokens: 1000,
      temperature: 0.1,
    },
  });

  const bedrockResponse = await bedrockClient.send(bedrockCommand);

  if (!bedrockResponse.output?.message?.content?.[0]?.text) {
    throw new Error("Invalid response from Bedrock Converse API");
  }

  const responseText = bedrockResponse.output.message.content[0].text;
  let parsedResponse;
  try {
    // Strip markdown code blocks if the model included them despite instructions
    const cleanJson = responseText
      .replace(/^```json\n/, "")
      .replace(/\n```$/, "")
      .trim();
    parsedResponse = JSON.parse(cleanJson);
  } catch (e) {
    console.error("Failed to parse LLM response as JSON:", responseText);
    throw new Error("LLM did not return a valid JSON object.");
  }

  const summaryText = parsedResponse.content || "";
  const summaryArray = parsedResponse.content_array || [];
  const githubSummaryArray = parsedResponse.github_content_array || [];
  const slackSummaryArray = parsedResponse.slack_content_array || [];

  const slackAggregator = aggregators.get("SLACK");
  const githubAggregator = aggregators.get("GITHUB");

  const slackMetrics = slackAggregator ? slackAggregator.getMetrics() : {};
  const githubMetrics = githubAggregator ? githubAggregator.getMetrics() : {};

  // 6. Write to Summary table
  const summaryData = {
    user_id: user_id,
    summary_type: summary_type,
    created_at: new Date().toISOString(),
    start_date: start_date,
    end_date: end_date,
    content: summaryText,
    content_array: summaryArray,
    github_content_array: githubSummaryArray,
    slack_content_array: slackSummaryArray,
    github_metrics: githubMetrics,
    slack_metrics: slackMetrics,
  };

  const { data: insertedData, error: insertError } = await (
    supabase.from("Summary") as any
  )
    .insert(summaryData)
    .select()
    .single();

  if (insertError) {
    throw new Error(`Failed to write summary to DB: ${insertError.message}`);
  }

  console.log(`Successfully generated and saved summary for user ${user_id}`);

  return { summary: insertedData, skipped: false };
}
