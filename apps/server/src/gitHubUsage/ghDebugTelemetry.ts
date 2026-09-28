import { isGitHubRateLimitMessage } from "@t3tools/contracts";

/**
 * Pure helpers behind the GitHub API usage report. Everything in this module
 * is deliberately free of I/O so the counting, redaction, and aggregation
 * semantics stay testable without spending real GitHub quota.
 *
 * Measurement semantics, stated plainly:
 * - A `gh` invocation is observed through `GH_DEBUG=api` stderr. Each
 *   `* Request to <url>` line is one measured HTTP request.
 * - When debug output is absent (older CLI, unexpected failure before any
 *   request), the request count is unknown — never invented.
 * - GraphQL cost points are not request counts and are never reported as such.
 */

export type GitHubApiUsageOutcome = "success" | "failure" | "rate-limited";

export interface GitHubApiRateLimitObservation {
  readonly resource: string;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly used: number | null;
  readonly resetAtMs: number | null;
}

export interface GitHubApiUsageEvent {
  readonly at: number;
  readonly operation: string;
  readonly feature: string;
  readonly host: string;
  readonly repository: string | null;
  readonly prNumber: number | null;
  /** Measured HTTP requests, or null where the invocation's count is unknown. */
  readonly httpRequests: number | null;
  readonly outcome: GitHubApiUsageOutcome;
  readonly latencyMs: number;
  readonly servedFromCache: boolean;
}

export interface GitHubApiUsageBreakdown {
  readonly key: string;
  readonly invocations: number;
  readonly httpRequests: number;
  readonly errors: number;
  readonly rateLimited: number;
}

export interface GitHubApiUsageTrendBucket {
  readonly at: number;
  readonly invocations: number;
  readonly httpRequests: number;
}

export interface GitHubApiUsageTotals {
  readonly invocations: number;
  readonly httpRequests: number;
  /** True when at least one invocation in the window has an unknown count. */
  readonly httpRequestsUnknown: boolean;
  readonly servedFromCache: number;
  readonly errors: number;
  readonly rateLimited: number;
}

const RATE_HEADER = /^<\s*x-ratelimit-(limit|remaining|used|reset|resource)\s*:\s*(.+?)\s*$/i;

function parsePositiveInt(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * What `GH_DEBUG=api` observed on stderr: how many HTTP requests one `gh`
 * invocation actually made, plus the latest rate-limit header block per
 * resource. Only the latest block per resource is kept — an invocation that
 * paged through three responses leaves the quota where the last one did.
 */
export function parseGhDebugTelemetry(stderr: string): {
  readonly httpRequestCount: number | null;
  readonly rateLimits: ReadonlyArray<GitHubApiRateLimitObservation>;
} {
  const lines = stderr.split("\n");
  let requests = 0;
  let current: Record<string, string> | null = null;
  const blocks: Array<Record<string, string>> = [];
  for (const line of lines) {
    if (/^\*\s+request\s+to\s+\S+/i.test(line.trim())) {
      requests += 1;
      current = {};
      blocks.push(current);
      continue;
    }
    if (current === null) continue;
    const match = RATE_HEADER.exec(line.trim());
    if (match) current[match[1]!.toLowerCase()] = match[2]!.trim();
  }
  if (requests === 0) return { httpRequestCount: null, rateLimits: [] };
  const latestByResource = new Map<string, GitHubApiRateLimitObservation>();
  for (const block of blocks) {
    const resource = (block["resource"] ?? "").toLowerCase();
    if (resource.length === 0) continue;
    const resetSeconds = block["reset"] === undefined ? null : parsePositiveInt(block["reset"]);
    latestByResource.set(resource, {
      resource,
      limit: block["limit"] === undefined ? null : parsePositiveInt(block["limit"]),
      remaining: block["remaining"] === undefined ? null : parsePositiveInt(block["remaining"]),
      used: block["used"] === undefined ? null : parsePositiveInt(block["used"]),
      resetAtMs: resetSeconds === null ? null : resetSeconds * 1_000,
    });
  }
  return {
    httpRequestCount: requests,
    rateLimits: [...latestByResource.values()].toSorted((left, right) =>
      left.resource.localeCompare(right.resource),
    ),
  };
}

/**
 * `GH_DEBUG=api` writes its request/response trace to stderr, which is also
 * where real error text lives. Strip every diagnostic line so failure details
 * stay small and never carry headers, tokens, or query dumps.
 */
export function stripGhDebugLines(stderr: string): string {
  const kept: Array<string> = [];
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("*") || trimmed.startsWith(">") || trimmed.startsWith("<")) continue;
    if (/^graphql\s+(query|variables)\s*:/i.test(trimmed)) continue;
    kept.push(line.trim());
  }
  // Drop dumped query bodies: a line that opens a GraphQL document is followed
  // by its body until the matching diagnostics resume.
  return kept.filter((line) => !/^(query|mutation|fragment|[{"])({|\s|$)/.test(line)).join("\n");
}

const KNOWN_SUBCOMMANDS = new Set([
  "pr list",
  "pr view",
  "pr diff",
  "pr checkout",
  "pr create",
  "pr comment",
  "pr merge",
  "pr close",
  "pr ready",
  "pr reopen",
  "pr status",
  "api graphql",
  "api",
  "repo view",
  "auth status",
  "search prs",
  "search issues",
]);

/**
 * The subcommand shape of a `gh` invocation (`pr list`, `api graphql`) for
 * telemetry labels. Only the command shape ever contributes — flags, search
 * text, bodies, endpoints' dynamic segments, and hostnames are never stored.
 */
export function summarizeGhArgs(args: ReadonlyArray<string>): string {
  const [command, ...rest] = args;
  if (command === undefined) return "gh";
  if (command === "api") {
    // `gh api [--hostname H] <endpoint>`: the endpoint names the call. Flags,
    // their values, and dynamic path segments never reach the label.
    const valueFlags = new Set([
      "--hostname",
      "-H",
      "--header",
      "-f",
      "--raw-field",
      "-F",
      "--field",
      "-X",
      "--method",
      "--input",
      "-q",
      "--jq",
      "--cache",
      "--template",
      "-t",
      "--preview",
      "-p",
    ]);
    let endpoint: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (valueFlags.has(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      endpoint = token;
      break;
    }
    if (endpoint === undefined) return "api";
    if (endpoint === "graphql") return "api graphql";
    const segment = endpoint.split(/[/?]/)[0] ?? "";
    return /^[a-z][a-z0-9_-]*$/i.test(segment) ? `api ${segment.toLowerCase()}` : "api";
  }
  const subcommand = rest[0];
  if (subcommand === undefined || !/^[a-z][a-z0-9-]*$/i.test(subcommand)) return "gh";
  const candidate = `${command} ${subcommand}`.toLowerCase();
  if (KNOWN_SUBCOMMANDS.has(candidate)) return candidate;
  return /^[a-z][a-z0-9-]*$/i.test(command) ? command.toLowerCase() : "gh";
}

export function classifyGhOutcome(input: {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stderr: string;
}): GitHubApiUsageOutcome {
  if (input.timedOut) return "failure";
  if (input.code === null || input.code !== 0) {
    return isGitHubRateLimitMessage(stripGhDebugLines(input.stderr)) ? "rate-limited" : "failure";
  }
  return "success";
}

function breakdown(
  events: ReadonlyArray<GitHubApiUsageEvent>,
  keyOf: (event: GitHubApiUsageEvent) => string,
): Array<GitHubApiUsageBreakdown> {
  const byKey = new Map<string, GitHubApiUsageBreakdown>();
  for (const event of events) {
    const key = keyOf(event);
    const held = byKey.get(key);
    if (held === undefined) {
      byKey.set(key, {
        key,
        invocations: 1,
        httpRequests: event.httpRequests ?? 0,
        errors: event.outcome === "failure" ? 1 : 0,
        rateLimited: event.outcome === "rate-limited" ? 1 : 0,
      });
    } else {
      byKey.set(key, {
        key,
        invocations: held.invocations + 1,
        httpRequests: held.httpRequests + (event.httpRequests ?? 0),
        errors: held.errors + (event.outcome === "failure" ? 1 : 0),
        rateLimited: held.rateLimited + (event.outcome === "rate-limited" ? 1 : 0),
      });
    }
  }
  return [...byKey.values()].toSorted(
    (left, right) => right.httpRequests - left.httpRequests || right.invocations - left.invocations,
  );
}

/**
 * Rolling-window aggregation over a bounded event buffer. Callers pass
 * already-retained events; the window filter here keeps the report honest
 * about what each window actually covers.
 */
export function aggregateUsage(
  events: ReadonlyArray<GitHubApiUsageEvent>,
  input: { readonly nowMs: number; readonly windowMs: number; readonly trendBuckets?: number },
): {
  readonly totals: GitHubApiUsageTotals;
  readonly byFeature: ReadonlyArray<GitHubApiUsageBreakdown>;
  readonly byOperation: ReadonlyArray<GitHubApiUsageBreakdown>;
  readonly byRepository: ReadonlyArray<GitHubApiUsageBreakdown>;
  readonly byHost: ReadonlyArray<GitHubApiUsageBreakdown>;
  readonly trend: ReadonlyArray<GitHubApiUsageTrendBucket>;
  readonly recent: ReadonlyArray<GitHubApiUsageEvent>;
} {
  const inWindow = events.filter(
    (event) => event.at <= input.nowMs && event.at > input.nowMs - input.windowMs,
  );
  const bucketCount = Math.max(1, Math.min(24, input.trendBuckets ?? 12));
  const bucketMs = input.windowMs / bucketCount;
  const trend = Array.from({ length: bucketCount }, (_, index) => ({
    at: input.nowMs - input.windowMs + Math.floor((index + 1) * bucketMs),
    invocations: 0,
    httpRequests: 0,
  }));
  let httpRequests = 0;
  let httpRequestsUnknown = false;
  let servedFromCache = 0;
  let errors = 0;
  let rateLimited = 0;
  for (const event of inWindow) {
    if (event.httpRequests === null) httpRequestsUnknown = true;
    else httpRequests += event.httpRequests;
    if (event.servedFromCache) servedFromCache += 1;
    if (event.outcome === "failure") errors += 1;
    if (event.outcome === "rate-limited") rateLimited += 1;
    const bucket = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((event.at - (input.nowMs - input.windowMs)) / bucketMs)),
    );
    trend[bucket]!.invocations += 1;
    trend[bucket]!.httpRequests += event.httpRequests ?? 0;
  }
  return {
    totals: {
      invocations: inWindow.length,
      httpRequests,
      httpRequestsUnknown,
      servedFromCache,
      errors,
      rateLimited,
    },
    byFeature: breakdown(inWindow, (event) => event.feature),
    byOperation: breakdown(inWindow, (event) => event.operation),
    byRepository: breakdown(
      inWindow.filter((event) => event.repository !== null),
      (event) => `${event.host}/${event.repository!}`,
    ),
    byHost: breakdown(inWindow, (event) => event.host),
    trend,
    recent: [...inWindow]
      .toSorted((left, right) => right.at - left.at)
      .slice(0, 50)
      .map((event) => ({ ...event })),
  };
}
