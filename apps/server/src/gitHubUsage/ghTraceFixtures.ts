/**
 * Format-faithful `GH_DEBUG=api` stderr fixtures with synthetic values.
 *
 * Shapes were captured from real `gh` 2.80.0 traces (REST success, REST
 * error, GraphQL error) and re-skinned: logins, ids, timestamps, and every
 * body field are synthetic. `SYNTHETIC_PRIVATE_BODY` marks content that must
 * never survive sanitization — it stands in for repo data, emails, and other
 * private API payloads that real traces dump verbatim.
 */

/** REST 200 with a multiline JSON response body dumped after the headers. */
export const TRACE_SUCCESS_REST = [
  "* Request at 2026-09-28 21:40:09.34538 -0700 PDT m=+0.033301542",
  "* Request to https://api.github.com/user",
  "> GET /user HTTP/1.1",
  "> Host: api.github.com",
  "> Accept: */*",
  "> Authorization: token ████████████████████",
  "> Content-Type: application/json; charset=utf-8",
  "> Time-Zone: America/Los_Angeles",
  "> User-Agent: GitHub CLI 2.80.0",
  "",
  "< HTTP/2.0 200 OK",
  "< Content-Type: application/json; charset=utf-8",
  "< X-Ratelimit-Limit: 5000",
  "< X-Ratelimit-Remaining: 3576",
  "< X-Ratelimit-Reset: 1790659280",
  "< X-Ratelimit-Resource: core",
  "< X-Ratelimit-Used: 1424",
  "",
  "{",
  '  "login": "synthetic-user",',
  '  "id": 12345,',
  '  "private_fixture": "SYNTHETIC_PRIVATE_BODY",',
  '  "nested": { "deep": ["aaa", "bbb"] }',
  "}",
  "",
  "* Request took 254.016959ms",
].join("\n");

/** REST 404: dumped error body plus gh's own single-line summary. */
export const TRACE_ERROR_404 = [
  "* Request at 2026-09-28 21:40:18.24163 -0700 PDT m=+0.035930376",
  "* Request to https://api.github.com/repos/synthetic-org/synthetic-repo/pulls/99999999",
  "> GET /repos/synthetic-org/synthetic-repo/pulls/99999999 HTTP/1.1",
  "> Host: api.github.com",
  "> Authorization: token ████████████████████",
  "> User-Agent: GitHub CLI 2.80.0",
  "",
  "< HTTP/2.0 404 Not Found",
  "< Content-Type: application/json; charset=utf-8",
  "< X-Ratelimit-Remaining: 3575",
  "< X-Ratelimit-Reset: 1790659280",
  "< X-Ratelimit-Resource: core",
  "< X-Ratelimit-Limit: 5000",
  "< X-Ratelimit-Used: 1425",
  "",
  "{",
  '  "message": "Not Found SYNTHETIC_PRIVATE_BODY",',
  '  "documentation_url": "https://example.invalid/rest",',
  '  "status": "404"',
  "}",
  "",
  "* Request took 276.348875ms",
  "gh: Not Found (HTTP 404)",
].join("\n");

/**
 * GraphQL error over HTTP 200: dumped error body plus summary. Mirrors a live
 * exhausted-quota response with synthetic identity and reset.
 */
export const TRACE_GRAPHQL_RATE_LIMIT = [
  "* Request at 2026-09-28 21:40:26.505801 -0700 PDT m=+0.037688959",
  "* Request to https://api.github.com/graphql",
  "> POST /graphql HTTP/1.1",
  "> Host: api.github.com",
  "> Authorization: token ████████████████████",
  "> Content-Length: 38",
  "> Content-Type: application/json; charset=utf-8",
  "> User-Agent: GitHub CLI 2.80.0",
  "",
  "{",
  '  "query": "query { viewer { login } }"',
  "}",
  "",
  "< HTTP/2.0 200 OK",
  "< Content-Type: application/json; charset=utf-8",
  "< X-Ratelimit-Limit: 5000",
  "< X-Ratelimit-Remaining: 0",
  "< X-Ratelimit-Reset: 1790657591",
  "< X-Ratelimit-Resource: graphql",
  "< X-Ratelimit-Used: 5000",
  "",
  "{",
  '  "errors": [',
  "    {",
  '      "type": "RATE_LIMIT",',
  '      "code": "graphql_rate_limit",',
  '      "message": "API rate limit already exceeded for synthetic user 12345."',
  "    }",
  "  ]",
  "}",
  "",
  "* Request took 336.818958ms",
  "gh: API rate limit already exceeded for synthetic user 12345.",
].join("\n");

/**
 * `pr`-command variant: the query document and its variables are logged with
 * explicit markers before the response. Variables can carry caller-composed
 * search text, so the whole block must go.
 */
export const TRACE_GRAPHQL_DUMP = [
  "* Request at 2026-09-28 21:40:26.505801 -0700 PDT m=+0.037688959",
  "* Request to https://api.github.com/graphql",
  "> POST /graphql HTTP/1.1",
  "> Host: api.github.com",
  "> Authorization: token ████████████████████",
  "> User-Agent: GitHub CLI 2.80.0",
  "",
  "GraphQL query:",
  "query PullRequestList($owner: String!) {",
  "  repository(owner: $owner) {",
  "    pullRequests(first: 100) { nodes { number } }",
  "  }",
  "}",
  'GraphQL variables: {"owner": "SYNTHETIC_PRIVATE_BODY"}',
  "",
  "< HTTP/2.0 200 OK",
  "< X-Ratelimit-Resource: graphql",
  "< X-Ratelimit-Remaining: 4999",
  "< X-Ratelimit-Reset: 1790657591",
  "< X-Ratelimit-Limit: 5000",
  "< X-Ratelimit-Used: 1",
  "",
  '{"data": {"x": 1}}',
  "",
  "* Request took 100.123456ms",
].join("\n");

/** Benign 422: failure without any rate-limit signal. */
export const TRACE_ERROR_422 = [
  "* Request at 2026-09-28 21:40:26.505801 -0700 PDT m=+0.037688959",
  "* Request to https://api.github.com/repos/synthetic-org/synthetic-repo/pulls",
  "> POST /repos/synthetic-org/synthetic-repo/pulls HTTP/1.1",
  "> Host: api.github.com",
  "> Authorization: token ████████████████████",
  "> User-Agent: GitHub CLI 2.80.0",
  "",
  "< HTTP/2.0 422 Unprocessable Entity",
  "< Content-Type: application/json; charset=utf-8",
  "< X-Ratelimit-Resource: core",
  "< X-Ratelimit-Remaining: 4999",
  "",
  "{",
  '  "message": "Validation failed SYNTHETIC_PRIVATE_BODY",',
  '  "errors": [{"resource": "PullRequest", "field": "base"}]',
  "}",
  "",
  "* Request took 100.123456ms",
  "gh: Validation Failed",
].join("\n");

/** Two paginated requests in one invocation, each with a dumped body. */
export const TRACE_TWO_REQUESTS = [
  "* Request at 2026-09-28 21:40:26.505801 -0700 PDT m=+0.037688959",
  "* Request to https://api.github.com/repos/synthetic-org/synthetic-repo/pulls?page=1",
  "> GET /repos/synthetic-org/synthetic-repo/pulls?page=1 HTTP/1.1",
  "> Host: api.github.com",
  "> Authorization: token ████████████████████",
  "",
  "< HTTP/2.0 200 OK",
  "< X-Ratelimit-Resource: core",
  "< X-Ratelimit-Remaining: 4998",
  "",
  '[{"number": 1, "private_fixture": "SYNTHETIC_PRIVATE_BODY"}]',
  "",
  "* Request took 100.0ms",
  "* Request at 2026-09-28 21:40:26.605801 -0700 PDT m=+0.137688959",
  "* Request to https://api.github.com/repos/synthetic-org/synthetic-repo/pulls?page=2",
  "> GET /repos/synthetic-org/synthetic-repo/pulls?page=2 HTTP/1.1",
  "> Host: api.github.com",
  "> Authorization: token ████████████████████",
  "",
  "< HTTP/2.0 200 OK",
  "< X-Ratelimit-Resource: core",
  "< X-Ratelimit-Remaining: 4997",
  "",
  '[{"number": 2, "private_fixture": "SYNTHETIC_PRIVATE_BODY"}]',
  "",
  "* Request took 100.0ms",
].join("\n");

/** A 403 with trace-style retry headers, as refused quota responses carry. */
export const TRACE_RATE_LIMIT_403 = [
  "* Request at 2026-09-28 21:40:26.505801 -0700 PDT m=+0.037688959",
  "* Request to https://api.github.com/user",
  "> GET /user HTTP/1.1",
  "> Host: api.github.com",
  "> Authorization: token ████████████████████",
  "",
  "< HTTP/2.0 403 Forbidden",
  "< Retry-After: 120",
  "< X-Ratelimit-Reset: 1790657591",
  "< X-Ratelimit-Resource: core",
  "< X-Ratelimit-Remaining: 0",
  "< X-Ratelimit-Limit: 5000",
  "",
  '{"message": "API rate limit exceeded for authenticated user."}',
  "",
  "* Request took 100.0ms",
  "gh: API rate limit exceeded for authenticated user.",
].join("\n");
