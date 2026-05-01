# WDYGD Server Backend API Documentation

Welcome to the WDYGD (What Did You Get Done) backend repository. This document outlines the API endpoints exposed via Amazon API Gateway that are necessary for the frontend application to interact with the backend services.

All requests should be prefixed with your deployed API Gateway root URL (e.g., `https://<api-id>.execute-api.<region>.amazonaws.com/prod`).

---

## 1. User Configuration

### **GET `/user-config`**

Retrieves the user configuration based on their email.

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

### **POST `/user-config`**

Creates a new user configuration entry if one does not exist for the given email.

- **Body:**
  ```json
  {
    "email": "user@example.com"
  }
  ```
- **Response (201 Created / 200 OK if exists):**
  ```json
  {
    "message": "User config created successfully",
    "data": [{ ...user_object... }]
  }
  ```

---

## 2. Integration Connections (Manual)

If you need to manually connect an integration (without OAuth), use these endpoints.

### **GET `/integration-connection`**

Retrieves all integration connections for a specific user.

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
        "access_token": "token",
        "refresh_token": "token",
        "token_expiration": "ISO-8601"
      }
    ]
  }
  ```

### **POST `/integration-connection`**

Manually inserts a new integration connection.

- **Body:**
  ```json
  {
    "user_id": "uuid",
    "provider": "GITHUB" | "SLACK",
    "access_token": "token",
    "refresh_token": "token",
    "token_expiration": "ISO-8601"
  }
  ```
- **Response (201 Created):**
  ```json
  {
    "message": "Integration connection created successfully",
    "data": [{ ...integration_object... }]
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
- **Action:** Returns a `302 Redirect` to the provider's authorization page.

### **GET `/auth/<provider>/callback`**

The callback URL used by the OAuth provider. The frontend generally does not call this directly.

- **Action:** Stores the tokens securely in Supabase and returns a `302 Redirect` to the `redirectUrl` provided in the initiate step, appending `?success=true`.

### **GET `/auth/<provider>/status`**

Checks if the user has successfully connected the specific integration.

- **Query Parameters:**
  - `userId` (string, required): The user's ID.
- **Response (200 OK):**

  ```json
  // If connected:
  {
    "connected": true,
    "connectedAt": "ISO-8601",
    "tokenExpiration": "ISO-8601"
  }

  // If not connected:
  {
    "connected": false
  }
  ```

### **DELETE `/auth/<provider>`**

Disconnects the integration by deleting the tokens from the database.

- **Query Parameters:**
  - `userId` (string, required): The user's ID.
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

### **GET `/summary`**

Retrieves generated summaries for a user, optionally filtered by date range and type.

- **Query Parameters:**
  - `user_id` (string, required): The user's ID.
  - `start_date` (string, optional): ISO-8601 start boundary.
  - `end_date` (string, optional): ISO-8601 end boundary.
  - `summary_type` (string, optional): Enum: `"DAILY"` or `"USER_GENERATED"`.
- **Response (200 OK):**
  ```json
  {
    "data": [
      {
        "summary_id": "uuid",
        "user_id": "uuid",
        "summary_type": "DAILY",
        "created_at": "ISO-8601",
        "start_date": "ISO-8601",
        "end_date": "ISO-8601",
        "content": "Today I reviewed 3 PRs..."
      }
    ]
  }
  ```

### **POST `/summary`**

Requests the generation of a new summary. This puts a job onto an SQS queue which will asynchronously collect data from integrations and trigger the AI model.

- **Body:**
  ```json
  {
    "user_id": "uuid",
    "start_date": "ISO-8601",
    "end_date": "ISO-8601",
    "summary_type": "USER_GENERATED" // Defaults to USER_GENERATED
  }
  ```
- **Response (202 Accepted):**
  ```json
  {
    "message": "Summary job queued successfully"
  }
  ```

---

## Data Fetching / Internal Endpoints (`/github`, `/slack`)

The `/github` and `/slack` endpoints exposed via POST are intended for **internal orchestration** by the `IngestionLambda`. While exposed on API Gateway, they should generally not be called by the frontend directly. They require heavy payloads (`startDate`, `endDate`, `integrationId`, `userId`) and process vast amounts of background data into the `ActivityEvent` database.
