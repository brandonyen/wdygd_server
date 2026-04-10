# GitHub Integration Lambda

Fetches GitHub repository data (commits, PRs, reviews, issues) for a date range to generate LLM summaries.

## Setup

1. Copy `.env.example` to `.env` in the project root:
   ```bash
   cp .env.example .env
   ```

2. Add your GitHub token to `.env`:
   ```
   GITHUB_TOKEN=ghp_your_token_here
   ```

   Get a token at: GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
   Required scopes: `repo`, `read:user`

## Testing Locally

```bash
# Usage: npx ts-node test-local.ts [owner] [repo] [days|startDate] [endDate]

# Default (facebook/react, last 7 days)
npx ts-node functions/integrations/github/test-local.ts

# Custom repo (last 7 days)
npx ts-node functions/integrations/github/test-local.ts brandonyen wdygd_server

# Custom number of days
npx ts-node functions/integrations/github/test-local.ts brandonyen wdygd_server 30

# Custom date range
npx ts-node functions/integrations/github/test-local.ts brandonyen wdygd_server 2024-03-01 2024-03-07

# From a specific start date to now
npx ts-node functions/integrations/github/test-local.ts brandonyen wdygd_server 2024-03-01
```

## Running Unit Tests

```bash
npm test -- --testPathPattern="github"
```

## Deployed Endpoint

```
POST https://28gthv6fu1.execute-api.us-east-1.amazonaws.com/prod/github
```

CORS is enabled — can be called directly from the browser/frontend.

### Request Body

```json
{
  "githubToken": "ghp_xxx",      // Option 1: Direct token
  "userId": "user123",           // Option 2: OAuth user lookup (use one or the other)
  "owner": "facebook",
  "repo": "react",
  "startDate": "2024-03-01T00:00:00Z",
  "endDate": "2024-03-07T23:59:59Z",
  "includeIssues": true          // Optional, defaults to false
}
```

### Test with curl

```bash
curl -X POST https://28gthv6fu1.execute-api.us-east-1.amazonaws.com/prod/github \
  -H "Content-Type: application/json" \
  -d '{
    "githubToken": "ghp_yourtoken",
    "owner": "brandonyen",
    "repo": "wdygd_web",
    "startDate": "2025-01-01T00:00:00Z",
    "endDate": "2025-04-10T00:00:00Z"
  }'
```

### Response

```json
{
  "repository": { "owner": "brandonyen", "repo": "wdygd_web" },
  "dateRange": { "startDate": "...", "endDate": "..." },
  "commits": [
    { "sha": "f683036", "message": "first commit", "author": "Brandon Yen", "date": "2026-02-06T00:50:31Z", "url": "..." }
  ],
  "pullRequests": [
    { "number": 8, "title": "Main 2", "state": "open", "author": "beltemsa", "createdAt": "...", "mergedAt": null, "closedAt": null, "url": "...", "additions": 0, "deletions": 0, "changedFiles": 0, "reviewCount": 0 }
  ],
  "reviews": [
    { "prNumber": 2, "prTitle": "Feature/profile", "reviewer": "beltemsa", "state": "APPROVED", "submittedAt": "...", "url": "..." }
  ],
  "issues": [],
  "stats": {
    "totalCommits": 1,
    "totalPRsOpened": 8,
    "totalPRsMerged": 4,
    "totalPRsClosed": 3,
    "totalReviews": 1,
    "totalIssuesOpened": 0,
    "totalIssuesClosed": 0,
    "uniqueContributors": ["Brandon Yen", "beltemsa", "ivillanuu"]
  }
}
```

### Using the endpoint in the frontend

```ts
fetch("https://28gthv6fu1.execute-api.us-east-1.amazonaws.com/prod/github", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    githubToken: import.meta.env.VITE_GITHUB_TOKEN,
    owner: "brandonyen",
    repo: "wdygd_web",
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  }),
})
  .then((r) => r.json())
  .then((data) => {
    data.commits        // array of commits
    data.pullRequests   // array of PRs
    data.reviews        // array of reviews
    data.stats          // totals and uniqueContributors
  });
```

Add `VITE_GITHUB_TOKEN=ghp_yourtoken` to `wdygd_web/.env` for the frontend.

## OAuth Flow (Production)

For customer-facing use, the OAuth flow stores tokens so users don't need to provide them:

1. **Connect GitHub**: Redirect user to `GET /auth/github?userId=xxx&redirectUrl=https://yourapp.com/callback`
2. **Check Status**: `GET /auth/github/status?userId=xxx`
3. **Fetch Data**: Use `userId` instead of `githubToken` in requests
4. **Disconnect**: `DELETE /auth/github?userId=xxx`

### Environment Variables for OAuth

```
GITHUB_CLIENT_ID=your_oauth_app_client_id
GITHUB_CLIENT_SECRET=your_oauth_app_client_secret
GITHUB_REDIRECT_URI=https://your-api.com/auth/github/callback
```

Create an OAuth App at: GitHub → Settings → Developer settings → OAuth Apps
