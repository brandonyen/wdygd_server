import { getSupabase } from "./get-supabase-client";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({});

interface ProviderAggregator {
  aggregate(payload: any): void;
  getPrompt(): string;
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
    const events = p.events || [];
    for (const ev of events) {
      const repoName = ev.repo?.name;
      if (repoName) this.stats.repos.add(repoName);

      if (ev.type === "PushEvent" && ev.payload?.commits) {
        this.stats.commits += ev.payload.commits.length;
        for (const commit of ev.payload.commits) {
          if (commit.message && this.commitMessages.length < 20) {
            this.commitMessages.push(commit.message.split("\n")[0]);
          }
        }
      } else if (ev.type === "PullRequestEvent") {
        const action = ev.payload?.action;
        const pr = ev.payload?.pull_request;

        if (action === "opened") {
          this.stats.prsOpened++;
          if (pr && this.prDetails.length < 10) {
            this.prDetails.push({
              title: pr.title || "",
              body: pr.body || "",
              action: "opened",
            });
          }
        } else if (action === "closed") {
          if (pr?.merged) {
            this.stats.prsMerged++;
            if (pr && this.prDetails.length < 10) {
              this.prDetails.push({
                title: pr.title || "",
                body: pr.body || "",
                action: "merged",
              });
            }
          } else {
            this.stats.prsClosed++;
          }
        }
      } else if (ev.type === "PullRequestReviewEvent") {
        const action = ev.payload?.action;
        if (action === "created" || action === "submitted") {
          this.stats.totalReviews++;
        }
      } else if (ev.type === "IssuesEvent") {
        const action = ev.payload?.action;
        if (action === "opened") this.stats.totalIssuesOpened++;
        if (action === "closed") this.stats.totalIssuesClosed++;
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
      for (const msg of this.commitMessages.slice(0, 10)) {
        prompt += `- ${msg}\n`;
      }
      prompt += `\n`;
    }

    return prompt;
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
  const { data: existingSummaries, error: checkError } = await (
    supabase.from("Summary") as any
  )
    .select("*")
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
    return { summary: existingSummaries[0], skipped: true };
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
  let prompt = `You are an AI assistant. Generate a professional and concise daily summary of work activities based on the following aggregated data.\n\n`;

  for (const aggregator of aggregators.values()) {
    prompt += aggregator.getPrompt();
  }

  prompt += `\nPlease provide a concise, natural-language summary (1-2 paragraphs) detailing what was accomplished, reviewed, or discussed today. Do not hallucinate information not present in the data.`;

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

  const summaryText = bedrockResponse.output.message.content[0].text;

  // 6. Write to Summary table
  const summaryData = {
    user_id: user_id,
    summary_type: summary_type,
    created_at: new Date().toISOString(),
    start_date: start_date,
    end_date: end_date,
    content: summaryText,
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
