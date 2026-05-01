import { getSupabase } from "../../utils/get-supabase-client";

// ============================================================================
// Types
// ============================================================================

interface GitHubRequestParams {
  userId: string;
  integrationId: string;
  startDate: string; // ISO 8601 format (e.g., "2024-01-01T00:00:00Z")
  endDate: string; // ISO 8601 format
  includeIssues?: boolean;
}

interface GitHubCommit {
  sha: string;
  message: string;
  repo: string;
  url: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  repo: string;
  state: string;
  url: string;
  action: string;
}

interface GitHubReview {
  prNumber: number;
  prTitle: string;
  repo: string;
  state: string;
  url: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  repo: string;
  state: string;
  url: string;
  action: string;
}

interface GitHubSummaryData {
  user: string;
  dateRange: {
    startDate: string;
    endDate: string;
  };
  commits: GitHubCommit[];
  pullRequests: GitHubPullRequest[];
  reviews: GitHubReview[];
  issues?: GitHubIssue[];
  stats: {
    totalCommits: number;
    totalPRsOpened: number;
    totalPRsMerged: number;
    totalPRsClosed: number;
    totalReviews: number;
    totalIssuesOpened?: number;
    totalIssuesClosed?: number;
    reposTouched: string[];
  };
}

// ============================================================================
// Token Management
// ============================================================================

async function refreshGitHubToken(refreshToken: string) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GitHub credentials for token refresh");
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = (await response.json()) as any;
  if (data.error) {
    throw new Error(`GitHub token refresh failed: ${data.error_description}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}

// ============================================================================
// GitHub API Client
// ============================================================================

const GITHUB_API_BASE = "https://api.github.com";

async function githubFetch<T>(
  endpoint: string,
  token: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${GITHUB_API_BASE}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handler(event: any): Promise<any> {
  try {
    const params: GitHubRequestParams = event;

    // Validate required parameters
    if (!params.startDate || !params.endDate) {
      throw new Error("Missing required fields: startDate, endDate");
    }

    const supabase = await getSupabase();

    // Resolve GitHub token (via userId lookup)
    let githubToken: string;

    if (params.userId && params.integrationId) {
      const { data: integration, error: integrationError } = await (
        supabase as any
      )
        .from("IntegrationConnection")
        .select("access_token, refresh_token, token_expiration")
        .eq("integration_id", params.integrationId)
        .eq("user_id", params.userId)
        .single();

      if (integrationError || !integration?.access_token) {
        throw new Error(
          `GitHub account not connected. Failed to fetch integration credentials: ${integrationError?.message}`
        );
      }

      githubToken = integration.access_token;

      // Check if token needs to be refreshed
      if (
        integration.token_expiration &&
        new Date(integration.token_expiration) <= new Date()
      ) {
        console.log("GitHub token expired, attempting refresh...");

        if (!integration.refresh_token) {
          throw new Error("GitHub token expired and no refresh token available.");
        }

        try {
          const refreshResult = await refreshGitHubToken(
            integration.refresh_token,
          );
          githubToken = refreshResult.access_token;
          const newExpiration = refreshResult.expires_in
            ? new Date(
                Date.now() + refreshResult.expires_in * 1000,
              ).toISOString()
            : null;

          // Update DB with new token
          const { error: updateError } = await (supabase as any)
            .from("IntegrationConnection")
            .update({
              access_token: refreshResult.access_token,
              refresh_token: refreshResult.refresh_token,
              token_expiration: newExpiration,
            })
            .eq("integration_id", params.integrationId);

          if (updateError) {
            console.error(
              "Failed to update IntegrationConnection with refreshed GitHub token:",
              updateError,
            );
          } else {
            console.log("Successfully refreshed and updated GitHub token.");
          }
        } catch (refreshErr) {
          console.error("GitHub token refresh failed:", refreshErr);
          throw new Error("Failed to refresh GitHub token.");
        }
      }
    } else {
      throw new Error("Authentication required: provide ('userId' and 'integrationId')");
    }

    // Validate date format
    const startDate = new Date(params.startDate);
    const endDate = new Date(params.endDate);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new Error("Invalid date format. Use ISO 8601 format.");
    }

    if (startDate > endDate) {
      throw new Error("startDate must be before endDate");
    }

    // 1. Get authenticated user's username
    const userRes = await githubFetch<{ login: string }>("/user", githubToken);
    const username = userRes.login;

    // 2. Fetch events paginated until we hit the start date or run out of pages
    const events: any[] = [];
    let page = 1;
    
    console.log(`Fetching events for user ${username} from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    while (true) {
      const pageEvents = await githubFetch<any[]>(`/users/${username}/events`, githubToken, {
        page: String(page),
        per_page: "100",
      });

      if (!pageEvents || pageEvents.length === 0) break;

      let reachedOlderEvents = false;

      for (const ev of pageEvents) {
        const evDate = new Date(ev.created_at);

        if (evDate > endDate) continue; // Skip events newer than end date
        if (evDate < startDate) {
          reachedOlderEvents = true; // Stop processing further once we pass the start date
          break;
        }

        events.push(ev);
      }

      // GitHub limits events API to 300 events or 90 days, so we break if we reach older events or run out of results
      if (reachedOlderEvents || pageEvents.length < 100) break;
      
      page++;
    }

    console.log(`Found ${events.length} events in the specified date range.`);

    // 3. Parse the events into our SummaryData
    const commits: GitHubCommit[] = [];
    const prs = new Map<number, GitHubPullRequest>();
    const reviews: GitHubReview[] = [];
    const issues = new Map<number, GitHubIssue>();
    const reposTouched = new Set<string>();

    let totalPRsOpened = 0;
    let totalPRsMerged = 0;
    let totalPRsClosed = 0;
    let totalIssuesOpened = 0;
    let totalIssuesClosed = 0;

    for (const ev of events) {
      const repoName = ev.repo.name;
      reposTouched.add(repoName);

      if (ev.type === "PushEvent" && ev.payload.commits) {
        for (const commit of ev.payload.commits) {
          // GitHub's PushEvent only contains commits pushed by this user.
          commits.push({
            sha: commit.sha.substring(0, 7),
            message: commit.message.split("\n")[0],
            repo: repoName,
            url: `https://github.com/${repoName}/commit/${commit.sha}`,
          });
        }
      } else if (ev.type === "PullRequestEvent") {
        const pr = ev.payload.pull_request;
        const action = ev.payload.action;

        if (action === "opened") totalPRsOpened++;
        if (action === "closed") {
          if (pr.merged) totalPRsMerged++;
          else totalPRsClosed++;
        }

        prs.set(pr.id, {
          number: pr.number,
          title: pr.title,
          repo: repoName,
          state: pr.state,
          url: pr.html_url,
          action: action,
        });
      } else if (ev.type === "PullRequestReviewEvent") {
        const action = ev.payload.action;
        if (action === "created" || action === "submitted") {
          reviews.push({
            prNumber: ev.payload.pull_request.number,
            prTitle: ev.payload.pull_request.title,
            repo: repoName,
            state: ev.payload.review.state,
            url: ev.payload.review.html_url,
          });
        }
      } else if (ev.type === "IssuesEvent" && params.includeIssues) {
        const issue = ev.payload.issue;
        const action = ev.payload.action;

        if (action === "opened") totalIssuesOpened++;
        if (action === "closed") totalIssuesClosed++;

        issues.set(issue.id, {
          number: issue.number,
          title: issue.title,
          repo: repoName,
          state: issue.state,
          url: issue.html_url,
          action: action,
        });
      }
    }

    const summaryData: GitHubSummaryData = {
      user: username,
      dateRange: {
        startDate: params.startDate,
        endDate: params.endDate,
      },
      commits,
      pullRequests: Array.from(prs.values()),
      reviews,
      ...(params.includeIssues && { issues: Array.from(issues.values()) }),
      stats: {
        totalCommits: commits.length,
        totalPRsOpened,
        totalPRsMerged,
        totalPRsClosed,
        totalReviews: reviews.length,
        ...(params.includeIssues && {
          totalIssuesOpened,
          totalIssuesClosed,
        }),
        reposTouched: Array.from(reposTouched),
      },
    };

    if (params.userId && params.integrationId) {
      const activityEvent = {
        user_id: params.userId,
        integration_id: params.integrationId,
        timestamp: new Date().toISOString(),
        payload: summaryData,
      };

      const { error: insertError } = await (supabase as any)
        .from("ActivityEvent")
        .insert([activityEvent]);

      if (insertError) {
        console.error(
          "Failed to write GitHub activity event to DB:",
          insertError,
        );
      } else {
        console.log("Wrote GitHub activity event to DB successfully");
      }
    }

    return summaryData;
  } catch (error) {
    console.error("Error fetching GitHub data:", error);
    throw error;
  }
}
