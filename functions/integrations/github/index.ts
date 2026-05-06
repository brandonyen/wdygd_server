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
  console.log(
    `GitHub integration lambda triggered with event:`,
    JSON.stringify(event),
  );
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
          `GitHub account not connected. Failed to fetch integration credentials: ${integrationError?.message}`,
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
          throw new Error(
            "GitHub token expired and no refresh token available.",
          );
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
      throw new Error(
        "Authentication required: provide ('userId' and 'integrationId')",
      );
    }

    // Validate date format
    const startDateObj = new Date(params.startDate);
    const endDateObj = new Date(params.endDate);

    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
      throw new Error("Invalid date format. Use ISO 8601 format.");
    }

    if (startDateObj > endDateObj) {
      throw new Error("startDate must be before endDate");
    }

    // 1. Get authenticated user's username
    const userRes = await githubFetch<{ login: string }>("/user", githubToken);
    const username = userRes.login;

    // Remove milliseconds for GitHub Search API format
    const startDateStr = startDateObj.toISOString().split(".")[0] + "Z";
    const endDateStr = endDateObj.toISOString().split(".")[0] + "Z";

    console.log(
      `Fetching data for user ${username} from ${startDateStr} to ${endDateStr} using Search APIs`,
    );

    const stats = {
      commits: 0,
      prsOpened: 0,
      prsMerged: 0,
      prsClosed: 0,
      totalReviews: 0,
      totalIssuesOpened: 0,
      totalIssuesClosed: 0,
      repos: [] as string[],
    };
    const reposSet = new Set<string>();
    const commitMessages: string[] = [];
    const prDetails: { title: string; body: string; action: string }[] = [];

    // 2. Fetch Commits via Search API
    try {
      const commitsQuery = `author:${username} committer-date:${startDateStr}..${endDateStr}`;
      const commitsRes = await githubFetch<any>(
        "/search/commits",
        githubToken,
        {
          q: commitsQuery,
          per_page: "100",
        },
      );

      const commitsData = commitsRes.items || [];
      stats.commits = commitsData.length;

      for (const commit of commitsData) {
        if (commit.repository?.name) {
          reposSet.add(commit.repository.name);
        }
        if (commit.commit?.message && commitMessages.length < 50) {
          commitMessages.push(commit.commit.message.split("\n")[0]);
        }
      }
    } catch (e) {
      console.error("Error fetching commits from Search API:", e);
    }

    // 3. Fetch Authored PRs
    try {
      const prsQuery = `author:${username} type:pr updated:${startDateStr}..${endDateStr}`;
      const prsRes = await githubFetch<any>("/search/issues", githubToken, {
        q: prsQuery,
        per_page: "100",
      });

      const prsData = prsRes.items || [];
      for (const pr of prsData) {
        const repoUrl = pr.repository_url;
        if (repoUrl) {
          const repoName = repoUrl.split("/repos/")[1];
          if (repoName) reposSet.add(repoName);
        }

        const createdAt = new Date(pr.created_at);
        const closedAt = pr.closed_at ? new Date(pr.closed_at) : null;

        if (createdAt >= startDateObj && createdAt <= endDateObj) {
          stats.prsOpened++;
          if (prDetails.length < 10) {
            prDetails.push({
              title: pr.title,
              body: pr.body || "",
              action: "opened",
            });
          }
        }

        if (closedAt && closedAt >= startDateObj && closedAt <= endDateObj) {
          if (pr.pull_request?.merged_at) {
            stats.prsMerged++;
            if (prDetails.length < 10) {
              prDetails.push({
                title: pr.title,
                body: pr.body || "",
                action: "merged",
              });
            }
          } else {
            stats.prsClosed++;
          }
        }
      }
    } catch (e) {
      console.error("Error fetching authored PRs from Search API:", e);
    }

    // 4. Fetch Reviewed PRs
    try {
      const reviewsQuery = `reviewed-by:${username} type:pr updated:${startDateStr}..${endDateStr}`;
      const reviewsRes = await githubFetch<any>("/search/issues", githubToken, {
        q: reviewsQuery,
        per_page: "100",
      });

      // Rough estimate: we just count PRs the user reviewed that had activity in this window.
      // To get exact review objects requires iterating /pulls/{pr}/reviews, which is rate limit heavy.
      const reviewsData = reviewsRes.items || [];
      stats.totalReviews = reviewsData.length;
    } catch (e) {
      console.error("Error fetching reviews from Search API:", e);
    }

    // 5. Fetch Issues (Optional)
    if (params.includeIssues) {
      try {
        const issuesQuery = `author:${username} type:issue updated:${startDateStr}..${endDateStr}`;
        const issuesRes = await githubFetch<any>(
          "/search/issues",
          githubToken,
          {
            q: issuesQuery,
            per_page: "100",
          },
        );

        const issuesData = issuesRes.items || [];
        for (const issue of issuesData) {
          const createdAt = new Date(issue.created_at);
          const closedAt = issue.closed_at ? new Date(issue.closed_at) : null;

          if (createdAt >= startDateObj && createdAt <= endDateObj) {
            stats.totalIssuesOpened++;
          }
          if (closedAt && closedAt >= startDateObj && closedAt <= endDateObj) {
            stats.totalIssuesClosed++;
          }
        }
      } catch (e) {
        console.error("Error fetching issues from Search API:", e);
      }
    }

    stats.repos = Array.from(reposSet);

    console.log(
      `Aggregation complete. Found ${stats.commits} commits and ${stats.prsOpened} PRs.`,
    );

    if (
      params.userId &&
      params.integrationId &&
      (stats.commits > 0 ||
        stats.prsOpened > 0 ||
        stats.prsClosed > 0 ||
        stats.prsMerged > 0 ||
        stats.totalReviews > 0 ||
        stats.totalIssuesOpened > 0 ||
        stats.totalIssuesClosed > 0)
    ) {
      const activityEvent = {
        user_id: params.userId,
        integration_id: params.integrationId,
        timestamp: new Date().toISOString(),
        payload: {
          username,
          dateRange: {
            startDate: params.startDate,
            endDate: params.endDate,
          },
          stats,
          commitMessages,
          prDetails,
        },
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

    return { username, stats };
  } catch (error) {
    console.error("Error fetching GitHub data:", error);
    throw error;
  }
}
