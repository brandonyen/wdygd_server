import { handler } from "./index";
import type { APIGatewayProxyEvent } from "aws-lambda";

// Mock fetch globally
// npm test -- --testPathPattern="github"

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("GitHub Integration Lambda", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it("should return 400 when body is missing", async () => {
    const event = {} as APIGatewayProxyEvent;
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe("Request body is required");
  });

  it("should return 400 when required fields are missing", async () => {
    const event = {
      body: JSON.stringify({ owner: "test" }),
    } as APIGatewayProxyEvent;

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain("Missing required field");
  });

  it("should return 400 for invalid date format", async () => {
    const event = {
      body: JSON.stringify({
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        startDate: "invalid-date",
        endDate: "2024-03-07T00:00:00Z",
      }),
    } as APIGatewayProxyEvent;

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain("Invalid date format");
  });

  it("should return 400 when startDate is after endDate", async () => {
    const event = {
      body: JSON.stringify({
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        startDate: "2024-03-10T00:00:00Z",
        endDate: "2024-03-01T00:00:00Z",
      }),
    } as APIGatewayProxyEvent;

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe("startDate must be before endDate");
  });

  it("should fetch and return GitHub data successfully", async () => {
    // Mock GitHub API responses
    mockFetch
      // Commits request
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            sha: "abc1234567890",
            commit: {
              message: "feat: add new feature",
              author: { name: "Test User", date: "2024-03-05T10:00:00Z" },
            },
            html_url: "https://github.com/test/repo/commit/abc1234",
          },
        ],
      })
      // Open PRs request
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      // Closed PRs request
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            number: 1,
            title: "Test PR",
            state: "closed",
            user: { login: "testuser" },
            created_at: "2024-03-04T10:00:00Z",
            merged_at: "2024-03-05T12:00:00Z",
            closed_at: "2024-03-05T12:00:00Z",
            html_url: "https://github.com/test/repo/pull/1",
            additions: 10,
            deletions: 5,
            changed_files: 2,
          },
        ],
      })
      // PR reviews request
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 1 }],
      })
      // All PRs for reviews
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            number: 1,
            title: "Test PR",
            updated_at: "2024-03-05T12:00:00Z",
          },
        ],
      })
      // Reviews for PR
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            user: { login: "reviewer" },
            state: "APPROVED",
            submitted_at: "2024-03-05T11:00:00Z",
            html_url: "https://github.com/test/repo/pull/1#pullrequestreview-1",
          },
        ],
      });

    const event = {
      body: JSON.stringify({
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        startDate: "2024-03-01T00:00:00Z",
        endDate: "2024-03-07T23:59:59Z",
      }),
    } as APIGatewayProxyEvent;

    const result = await handler(event);

    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.repository.owner).toBe("test-owner");
    expect(body.repository.repo).toBe("test-repo");
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0].message).toBe("feat: add new feature");
    expect(body.pullRequests).toHaveLength(1);
    expect(body.pullRequests[0].state).toBe("merged");
    expect(body.stats.totalCommits).toBe(1);
    expect(body.stats.uniqueContributors).toContain("Test User");
  });

  it("should handle GitHub API errors", async () => {
    const errorResponse = {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Bad credentials",
    };

    // All parallel requests will fail
    mockFetch.mockResolvedValue(errorResponse);

    const event = {
      body: JSON.stringify({
        githubToken: "invalid-token",
        owner: "test-owner",
        repo: "test-repo",
        startDate: "2024-03-01T00:00:00Z",
        endDate: "2024-03-07T23:59:59Z",
      }),
    } as APIGatewayProxyEvent;

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toContain("GitHub API error");
  });
});
