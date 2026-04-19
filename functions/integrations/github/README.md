# GitHub Integration

Fetches commits, PRs, reviews, and issues for a date range.

## Deployed Endpoint

```
POST https://28gthv6fu1.execute-api.us-east-1.amazonaws.com/prod/github
```

## API Usage

### With a direct token (current)

```json
{
  "githubToken": "ghp_xxx",
  "owner": "brandonyen",
  "repo": "wdygd_web",
  "startDate": "2026-01-01T00:00:00Z",
  "endDate": "2026-04-11T00:00:00Z",
  "includeIssues": true
}
```

### With OAuth (after setup)

```json
{
  "userId": "user123",
  "owner": "brandonyen",
  "repo": "wdygd_web",
  "startDate": "2026-01-01T00:00:00Z",
  "endDate": "2026-04-11T00:00:00Z"
}
```

### Response shape

```json
{
  "commits":      [{ "sha", "message", "author", "date", "url" }],
  "pullRequests": [{ "number", "title", "state", "author", "createdAt", "mergedAt", "closedAt", "url", "additions", "deletions", "changedFiles", "reviewCount" }],
  "reviews":      [{ "prNumber", "prTitle", "reviewer", "state", "submittedAt", "url" }],
  "issues":       [{ "number", "title", "state", "author", "createdAt", "closedAt", "url", "labels" }],
  "stats": {
    "totalCommits", "totalPRsOpened", "totalPRsMerged", "totalPRsClosed",
    "totalReviews", "totalIssuesOpened", "totalIssuesClosed", "uniqueContributors"
  }
}
```

## OAuth Setup

### 1. Register a GitHub OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App

- **Callback URL:** `https://28gthv6fu1.execute-api.us-east-1.amazonaws.com/prod/oauth/github/callback`

Copy the **Client ID** and **Client Secret**.

### 2. Set environment variables

```
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=secret123
GITHUB_REDIRECT_URI=https://28gthv6fu1.execute-api.us-east-1.amazonaws.com/prod/oauth/github/callback
```

### 3. Add OAuth routes to the CDK stack

| Method   | Path                     | Purpose                    |
| -------- | ------------------------ | -------------------------- |
| `GET`    | `/oauth/github`          | Start OAuth flow           |
| `GET`    | `/oauth/github/callback` | GitHub redirects here      |
| `GET`    | `/oauth/github/status`   | Check if user is connected |
| `DELETE` | `/oauth/github`          | Disconnect account         |

### 4. Replace token store with DynamoDB

The current store uses `/tmp` (local only). For Lambda persistence, implement `dynamoDBStore` in `token-store.ts` and set `TOKEN_STORE_TYPE=dynamodb`.

### 5. User flow

```
GET /oauth/github?userId=user123&redirectUrl=https://yourapp.com/callback
→ user authorizes on GitHub
→ GitHub redirects to callback → token stored under userId
→ use userId in API requests instead of githubToken
```

## Local Testing

```bash
# Requires GITHUB_TOKEN in .env at project root
npx ts-node functions/integrations/github/test-local.ts brandonyen wdygd_web 7
```
