# Slack Integration

Fetches messages and thread replies from channels the user is a member of, for a given date range.

## OAuth Endpoints

| Method   | Path                          | Purpose                  |
| -------- | ----------------------------- | ------------------------ |
| `GET`    | `/oauth/slack/initiate`       | Start OAuth flow         |
| `GET`    | `/oauth/slack/callback`       | Slack redirects here     |
| `DELETE` | `/oauth/slack`                | Disconnect account       |

Base URL: `https://28gthv6fu1.execute-api.us-east-1.amazonaws.com/prod`

---

## Connecting a Slack Account

### 1. Initiate the OAuth flow

Redirect the user to:

```
GET /oauth/slack/initiate?userId=<userId>&redirectUrl=<redirectUrl>
```

| Param         | Required | Description                                              |
| ------------- | -------- | -------------------------------------------------------- |
| `userId`      | Yes      | Your app's user ID (UUID)                                |
| `redirectUrl` | No       | Where to send the user after auth completes              |

The user will be taken to Slack to authorize. After they approve, Slack redirects to the callback Lambda automatically.

### 2. Handle the redirect

If you passed a `redirectUrl`, the user will land there with one of:

```
# Success
https://yourapp.com/settings?success=true

# Error
https://yourapp.com/settings?error=<error_code>
```

If no `redirectUrl` was passed, the callback returns JSON:

```json
{ "success": true, "message": "Slack account connected successfully" }
```

---

## Disconnecting a Slack Account

```
DELETE /oauth/slack?userId=<userId>
```

**Response:**

```json
{ "success": true, "message": "Slack account disconnected" }
```

---

## Fetching Slack Data

Once connected, invoke the Slack integration Lambda directly (e.g. via the scheduler) with:

```json
{
  "userId": "00000000-0000-0000-0000-000000000001",
  "integrationId": "<integration_id from IntegrationConnection table>",
  "startDate": "2026-04-01T00:00:00Z",
  "endDate": "2026-04-22T00:00:00Z"
}
```

### Response shape

```json
{
  "dateRange": { "start": "...", "end": "..." },
  "channels": [
    {
      "channelId": "C01234",
      "channelName": "general",
      "messages": [
        {
          "user": "Jane Doe",
          "text": "hello",
          "timestamp": "1713000000.000000",
          "threadReplies": [
            { "user": "John Smith", "text": "hey", "timestamp": "..." }
          ]
        }
      ]
    }
  ]
}
```

Only channels where the user sent at least one message are included.

---

## Local Testing

```bash
# 1. Get a Slack auth URL
npx ts-node -r dotenv/config functions/integrations/slack/oauth/test-initiate.ts

# 2. Open the URL, authorize, then paste the code + state into test-callback.ts and run:
npx ts-node -r dotenv/config functions/integrations/slack/oauth/test-callback.ts
```
