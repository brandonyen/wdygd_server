import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getTokenStore } from "./token-store.js";

// ============================================================================
// Types
// ============================================================================

interface GitHubRequestParams {
  // Authentication: provide either githubToken OR userId (for OAuth)
  githubToken?: string;
  userId?: string;
  // Repository info
  owner: string;
  repo: string;
  startDate: string; // ISO 8601 format (e.g., "2024-01-01T00:00:00Z")
  endDate: string; // ISO 8601 format
  includeIssues?: boolean;
}

interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  author: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewCount: number;
}

interface GitHubReview {
  prNumber: number;
  prTitle: string;
  reviewer: string;
  state: string;
  submittedAt: string;
  url: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  author: string;
  createdAt: string;
  closedAt: string | null;
  url: string;
  labels: string[];
}

interface GitHubSummaryData {
  repository: {
    owner: string;
    repo: string;
  };
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
    uniqueContributors: string[];
  };
}

// ============================================================================
// GitHub API Client
// ============================================================================

const GITHUB_API_BASE = "https://api.github.com";

async function githubFetch<T>(
  endpoint: string,
  token: string,
  params?: Record<string, string>
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
      `GitHub API error: ${response.status} ${response.statusText} - ${errorBody}`
    );
  }

  return response.json() as Promise<T>;
}

async function fetchAllPages<T>(
  endpoint: string,
  token: string,
  params?: Record<string, string>
): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const pageParams = { ...params, page: String(page), per_page: String(perPage) };
    const items = await githubFetch<T[]>(endpoint, token, pageParams);

    if (items.length === 0) break;

    allItems.push(...items);

    if (items.length < perPage) break;
    page++;
  }

  return allItems;
}

// ============================================================================
// Data Fetching Functions
// ============================================================================

async function fetchCommits(
  owner: string,
  repo: string,
  token: string,
  startDate: string,
  endDate: string
): Promise<GitHubCommit[]> {
  interface GitHubCommitResponse {
    sha: string;
    commit: {
      message: string;
      author: {
        name: string;
        date: string;
      };
    };
    html_url: string;
  }

  const commits = await fetchAllPages<GitHubCommitResponse>(
    `/repos/${owner}/${repo}/commits`,
    token,
    { since: startDate, until: endDate }
  );

  return commits.map((commit) => ({
    sha: commit.sha.substring(0, 7),
    message: commit.commit.message.split("\n")[0], // First line only
    author: commit.commit.author.name,
    date: commit.commit.author.date,
    url: commit.html_url,
  }));
}

async function fetchPullRequests(
  owner: string,
  repo: string,
  token: string,
  startDate: string,
  endDate: string
): Promise<GitHubPullRequest[]> {
  interface GitHubPRResponse {
    number: number;
    title: string;
    state: string;
    user: { login: string };
    created_at: string;
    merged_at: string | null;
    closed_at: string | null;
    html_url: string;
    additions: number;
    deletions: number;
    changed_files: number;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Fetch all PRs (both open and closed) to filter by date range
  const [openPRs, closedPRs] = await Promise.all([
    fetchAllPages<GitHubPRResponse>(
      `/repos/${owner}/${repo}/pulls`,
      token,
      { state: "open", sort: "updated", direction: "desc" }
    ),
    fetchAllPages<GitHubPRResponse>(
      `/repos/${owner}/${repo}/pulls`,
      token,
      { state: "closed", sort: "updated", direction: "desc" }
    ),
  ]);

  const allPRs = [...openPRs, ...closedPRs];

  // Filter PRs that were created, merged, or closed within the date range
  const relevantPRs = allPRs.filter((pr) => {
    const created = new Date(pr.created_at);
    const merged = pr.merged_at ? new Date(pr.merged_at) : null;
    const closed = pr.closed_at ? new Date(pr.closed_at) : null;

    return (
      (created >= start && created <= end) ||
      (merged && merged >= start && merged <= end) ||
      (closed && closed >= start && closed <= end)
    );
  });

  // Fetch review counts for each PR
  const prsWithReviews = await Promise.all(
    relevantPRs.map(async (pr) => {
      interface ReviewResponse {
        id: number;
      }
      const reviews = await githubFetch<ReviewResponse[]>(
        `/repos/${owner}/${repo}/pulls/${pr.number}/reviews`,
        token
      );
      return { ...pr, reviewCount: reviews.length };
    })
  );

  return prsWithReviews.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? "merged" : (pr.state as "open" | "closed"),
    author: pr.user.login,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    closedAt: pr.closed_at,
    url: pr.html_url,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    reviewCount: pr.reviewCount,
  }));
}

async function fetchReviews(
  owner: string,
  repo: string,
  token: string,
  startDate: string,
  endDate: string
): Promise<GitHubReview[]> {
  interface GitHubReviewResponse {
    user: { login: string };
    state: string;
    submitted_at: string;
    html_url: string;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Fetch recently updated PRs to get their reviews
  const recentPRs = await fetchAllPages<{
    number: number;
    title: string;
    updated_at: string;
  }>(`/repos/${owner}/${repo}/pulls`, token, {
    state: "all",
    sort: "updated",
    direction: "desc",
  });

  // Filter to PRs updated within or after start date
  const relevantPRs = recentPRs.filter(
    (pr) => new Date(pr.updated_at) >= start
  );

  const allReviews: GitHubReview[] = [];

  for (const pr of relevantPRs) {
    const reviews = await githubFetch<GitHubReviewResponse[]>(
      `/repos/${owner}/${repo}/pulls/${pr.number}/reviews`,
      token
    );

    const filteredReviews = reviews
      .filter((review) => {
        if (!review.submitted_at) return false;
        const submittedAt = new Date(review.submitted_at);
        return submittedAt >= start && submittedAt <= end;
      })
      .map((review) => ({
        prNumber: pr.number,
        prTitle: pr.title,
        reviewer: review.user.login,
        state: review.state,
        submittedAt: review.submitted_at,
        url: review.html_url,
      }));

    allReviews.push(...filteredReviews);
  }

  return allReviews;
}

async function fetchIssues(
  owner: string,
  repo: string,
  token: string,
  startDate: string,
  endDate: string
): Promise<GitHubIssue[]> {
  interface GitHubIssueResponse {
    number: number;
    title: string;
    state: string;
    user: { login: string };
    created_at: string;
    closed_at: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
    pull_request?: unknown;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  const issues = await fetchAllPages<GitHubIssueResponse>(
    `/repos/${owner}/${repo}/issues`,
    token,
    { state: "all", since: startDate, sort: "updated", direction: "desc" }
  );

  // Filter out PRs (GitHub API includes PRs in issues endpoint)
  const actualIssues = issues.filter((issue) => !issue.pull_request);

  // Filter issues by date range
  const relevantIssues = actualIssues.filter((issue) => {
    const created = new Date(issue.created_at);
    const closed = issue.closed_at ? new Date(issue.closed_at) : null;

    return (
      (created >= start && created <= end) ||
      (closed && closed >= start && closed <= end)
    );
  });

  return relevantIssues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state as "open" | "closed",
    author: issue.user.login,
    createdAt: issue.created_at,
    closedAt: issue.closed_at,
    url: issue.html_url,
    labels: issue.labels.map((l) => l.name),
  }));
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    // Parse request body
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }

    const params: GitHubRequestParams = JSON.parse(event.body);

    // Validate required parameters
    if (!params.owner || !params.repo || !params.startDate || !params.endDate) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required fields: owner, repo, startDate, endDate",
        }),
      };
    }

    // Resolve GitHub token (either direct or via userId lookup)
    let githubToken: string;

    if (params.githubToken) {
      githubToken = params.githubToken;
    } else if (params.userId) {
      const tokenStore = getTokenStore();
      const storedToken = await tokenStore.getToken(params.userId);

      if (!storedToken) {
        return {
          statusCode: 401,
          body: JSON.stringify({
            error: "GitHub account not connected. Please authenticate via OAuth first.",
            authRequired: true,
          }),
        };
      }

      githubToken = storedToken.accessToken;
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Authentication required: provide either 'githubToken' or 'userId'",
        }),
      };
    }

    // Validate date format
    const startDate = new Date(params.startDate);
    const endDate = new Date(params.endDate);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Invalid date format. Use ISO 8601 format.",
        }),
      };
    }

    if (startDate > endDate) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "startDate must be before endDate" }),
      };
    }

    // Fetch data from GitHub API
    const [commits, pullRequests, reviews, issues] = await Promise.all([
      fetchCommits(
        params.owner,
        params.repo,
        githubToken,
        params.startDate,
        params.endDate
      ),
      fetchPullRequests(
        params.owner,
        params.repo,
        githubToken,
        params.startDate,
        params.endDate
      ),
      fetchReviews(
        params.owner,
        params.repo,
        githubToken,
        params.startDate,
        params.endDate
      ),
      params.includeIssues
        ? fetchIssues(
            params.owner,
            params.repo,
            githubToken,
            params.startDate,
            params.endDate
          )
        : Promise.resolve(undefined),
    ]);

    // Calculate statistics
    const uniqueContributors = new Set<string>();
    commits.forEach((c) => uniqueContributors.add(c.author));
    pullRequests.forEach((pr) => uniqueContributors.add(pr.author));
    reviews.forEach((r) => uniqueContributors.add(r.reviewer));

    const summaryData: GitHubSummaryData = {
      repository: {
        owner: params.owner,
        repo: params.repo,
      },
      dateRange: {
        startDate: params.startDate,
        endDate: params.endDate,
      },
      commits,
      pullRequests,
      reviews,
      ...(issues && { issues }),
      stats: {
        totalCommits: commits.length,
        totalPRsOpened: pullRequests.filter((pr) => {
          const created = new Date(pr.createdAt);
          return created >= startDate && created <= endDate;
        }).length,
        totalPRsMerged: pullRequests.filter((pr) => pr.state === "merged")
          .length,
        totalPRsClosed: pullRequests.filter(
          (pr) => pr.state === "closed" && pr.closedAt
        ).length,
        totalReviews: reviews.length,
        ...(issues && {
          totalIssuesOpened: issues.filter((i) => {
            const created = new Date(i.createdAt);
            return created >= startDate && created <= endDate;
          }).length,
          totalIssuesClosed: issues.filter((i) => i.closedAt !== null).length,
        }),
        uniqueContributors: Array.from(uniqueContributors),
      },
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(summaryData, null, 2),
    };
  } catch (error) {
    console.error("Error fetching GitHub data:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage }),
    };
  }
}
