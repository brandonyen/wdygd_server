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

## API Usage

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

### Response

Returns structured data with:
- `commits` - List of commits with sha, message, author, date, url
- `pullRequests` - PRs with state (open/closed/merged), review count, additions/deletions
- `reviews` - Code reviews with reviewer, state (APPROVED/CHANGES_REQUESTED/COMMENTED)
- `issues` - Issues with labels (if `includeIssues: true`)
- `stats` - Aggregated counts and unique contributors list

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
