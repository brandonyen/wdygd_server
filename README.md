# WDYGD Server Backend API Documentation

Welcome to the WDYGD (What Did You Get Done) backend repository. This document outlines the API endpoints exposed via Amazon API Gateway that are necessary for the frontend application to interact with the backend services.

All requests should be prefixed with your deployed API Gateway root URL (e.g., `https://<api-id>.execute-api.<region>.amazonaws.com/prod`).

---

## 1. User Configuration

### **GET `/user-config`**

Retrieves the user configuration based on their email. **Note:** This endpoint does not require Cognito authentication.

- **Query Parameters:**
  - `email` (string, required): The user's email address.
- **Response (200 OK):**
  ```json
  {
    "data": {
      "user_id": "uuid",
      "email": "user@example.com",
      "created_at": "ISO-8601",
      "last_sync": "ISO-8601"
    }
  }
  ```
- **Error Responses:** `400 Bad Request` (Missing email), `404 Not Found` (User not found).

---

## 2. Integration Connections (Manual)

If you need to manually connect an integration (without OAuth), use these endpoints.

### **GET `/integration-connection`**

Retrieves all integration connections for a specific user. **Note:** This endpoint does not require Cognito authentication.

- **Query Parameters:**
  - `user_id` (string, required): The user's ID.
- **Response (200 OK):**
  ```json
  {
    "data": [
      {
        "integration_id": "uuid",
        "user_id": "uuid",
        "provider": "GITHUB" | "SLACK",
        "provider_workspace_id": "string", // Slack workspace ID
        "token_expiration": "ISO-8601",
        "created_at": "ISO-8601"
      }
    ]
  }
  ```

---

## 3. OAuth Authentication Flows (GitHub & Slack)

The backend provides managed OAuth flows for GitHub and Slack to securely acquire tokens without the frontend ever seeing them. Replace `<provider>` with `github` or `slack`.

### **GET `/auth/<provider>`** (Initiate)

Starts the OAuth flow. The frontend should redirect the user to this URL.

- **Query Parameters:**
  - `userId` (string, required): The internal user ID.
  - `redirectUrl` (string, optional): The frontend URL to redirect back to upon completion.
  - `teamId` (string, optional, Slack only): The Slack team/workspace ID to pre-select.
- **Action:** Returns a `302 Redirect` to the provider's authorization page.

### **GET `/auth/<provider>/callback`**

The callback URL used by the OAuth provider. The frontend generally does not call this directly.

- **Action:** Stores the tokens securely in Supabase and returns a `302 Redirect` to the `redirectUrl` provided in the initiate step, appending `?success=true`.

### **DELETE `/auth/<provider>`**

Disconnects the integration by deleting the tokens from the database.

- **Query Parameters:**
  - `userId` (string, required): The user's ID.
  - `workspaceId` (string, optional, Slack only): The specific workspace to disconnect.
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Account disconnected"
  }
  ```

---

## 4. Summaries API

These endpoints allow the frontend to fetch generated summaries or manually request the generation of a new summary.

### **POST `/sync`**

Starts the data collection and summary generation process for a specific user for the past 24 hours. The generated summary will have a `summary_type` of `"DAILY"`.

- **Body:**
  ```json
  {
    "user_id": "uuid"
  }
  ```
- **Response (202 Accepted):**
  ```json
  {
    "message": "Data collection and summary generation started for the past day."
  }
  ```

### **GET `/summary`**

Retrieves generated summaries for a user, optionally filtered by date range and type. **Note:** This endpoint does not require Cognito authentication.

- **Query Parameters:**
  - `user_id` (string, required): The user's ID.
  - `start_date` (string, optional): ISO-8601 start boundary.
  - `end_date` (string, optional): ISO-8601 end boundary.
  - `summary_type` (string, optional): Enum: `"DAILY"` or `"USER_GENERATED"`.
  - `latest` (boolean, optional): If set to `true`, only the most recent summary matching the filters will be returned (as a single object instead of an array).
- **Response (200 OK):**
  ```json
  {
    "data": [
      {
        "summary_id": "uuid",
        "user_id": "uuid",
  ...
        "summary_type": "DAILY",
        "created_at": "ISO-8601",
        "start_date": "ISO-8601",
        "end_date": "ISO-8601",
        "content": "Today I reviewed 3 PRs...",
        "content_array": ["Reviewed 3 PRs...", "Merged feature branch..."]
      }
    ]
  }
  ```

### **POST `/summary`**

Requests the generation of a new summary from previously collected data. The generation is done synchronously and the resulting summary is immediately returned in the response as well as saved to the database.

- **Body:**
  ```json
  {
    "user_id": "uuid",
    "start_date": "ISO-8601",
    "end_date": "ISO-8601",
    "summary_type": "USER_GENERATED" // Defaults to USER_GENERATED
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "message": "Summary generated successfully",
    "data": {
      "summary_id": "uuid",
      "user_id": "uuid",
      "summary_type": "USER_GENERATED",
      "created_at": "ISO-8601",
      "start_date": "ISO-8601",
      "end_date": "ISO-8601",
      "content": "...",
      "content_array": ["...", "..."]
    }
  }
  ```

---

## 5. Background Jobs

### **Automated Daily Summaries**

The backend relies on an Amazon EventBridge scheduler that triggers every 5 minutes. During this execution, it identifies users who need a daily summary (i.e. those who haven't had a sync in the last 24 hours).

For these users, it automatically runs the full ingestion pipeline:

1. Fetches fresh data from all connected integrations (GitHub via the Search API, Slack channels).
2. Synthesizes this data.
3. Generates a new `DAILY` summary using the AWS Bedrock LLM.
4. Updates the `last_sync` field in their `UserConfig`.
