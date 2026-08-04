export type GitHubCheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface GitHubCheck {
  readonly name: string;
  readonly bucket: GitHubCheckBucket;
  readonly duration?: string;
  readonly link?: string;
  readonly description?: string;
  readonly workflow?: string;
}

export interface GitHubActionsSnapshot {
  readonly kind: "pr-checks";
  readonly watching: boolean;
  readonly checks: ReadonlyArray<GitHubCheck>;
}

export interface GitHubActionsSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  readonly skipped: number;
  readonly cancelled: number;
}

const MAX_CHECKS = 50;
const MAX_OUTPUT_LENGTH = 200_000;
const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_CSI_SEQUENCE = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-?]*[ -/]*[@-~]`, "g");
const CHECK_BUCKETS = new Set<GitHubCheckBucket>(["pass", "fail", "pending", "skipping", "cancel"]);

function trimmed(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  if (result.length === 0) return undefined;
  return result.slice(0, maxLength);
}

function bucket(value: unknown): GitHubCheckBucket | undefined {
  const result = trimmed(value)?.toLowerCase() as GitHubCheckBucket | undefined;
  return result && CHECK_BUCKETS.has(result) ? result : undefined;
}

function externalLink(value: unknown): string | undefined {
  const link = trimmed(value);
  return link && /^https:\/\//i.test(link) ? link : undefined;
}

export function readGitHubActionsSnapshot(value: unknown): GitHubActionsSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "pr-checks" || typeof record.watching !== "boolean") return null;
  if (!Array.isArray(record.checks)) return null;

  const checks: GitHubCheck[] = [];
  for (const value of record.checks.slice(0, MAX_CHECKS)) {
    if (!value || typeof value !== "object") continue;
    const check = value as Record<string, unknown>;
    const name = trimmed(check.name, 200);
    const checkBucket = bucket(check.bucket);
    if (!name || !checkBucket) continue;
    const link = externalLink(check.link);
    checks.push({
      name,
      bucket: checkBucket,
      ...(trimmed(check.duration, 40) ? { duration: trimmed(check.duration, 40)! } : {}),
      ...(link ? { link } : {}),
      ...(trimmed(check.description) ? { description: trimmed(check.description)! } : {}),
      ...(trimmed(check.workflow, 200) ? { workflow: trimmed(check.workflow, 200)! } : {}),
    });
  }
  return { kind: "pr-checks", watching: record.watching, checks };
}

export function summarizeGitHubActions(snapshot: GitHubActionsSnapshot): GitHubActionsSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let skipped = 0;
  let cancelled = 0;
  for (const check of snapshot.checks) {
    if (check.bucket === "pass") passed += 1;
    if (check.bucket === "fail") failed += 1;
    if (check.bucket === "pending") pending += 1;
    if (check.bucket === "skipping") skipped += 1;
    if (check.bucket === "cancel") cancelled += 1;
  }
  return {
    total: snapshot.checks.length,
    passed,
    failed,
    pending,
    skipped,
    cancelled,
  };
}

function commandText(command: unknown): string | null {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return null;
  const parts = command.filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? parts.join(" ") : null;
}

export function isGitHubPrChecksCommand(command: unknown): boolean {
  const value = commandText(command);
  if (!value) return false;
  return /(?:^|[\s;&|])(?:["'][^"']*[\\/])?gh["']?\s+pr\s+checks(?:\s|$)/i.test(value);
}

function parseJsonChecks(output: string): GitHubCheck[] | null {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const checks: GitHubCheck[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const name = trimmed(record.name, 200);
    const checkBucket = bucket(record.bucket);
    if (!name || !checkBucket) continue;
    const link = externalLink(record.link);
    checks.push({
      name,
      bucket: checkBucket,
      ...(link ? { link } : {}),
      ...(trimmed(record.description) ? { description: trimmed(record.description)! } : {}),
      ...(trimmed(record.workflow, 200) ? { workflow: trimmed(record.workflow, 200)! } : {}),
    });
    if (checks.length >= MAX_CHECKS) break;
  }
  return checks;
}

function parseTableChecks(output: string): GitHubCheck[] {
  const byIdentity = new Map<string, GitHubCheck>();
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.split("\t");
    if (columns.length < 2) continue;
    const name = trimmed(columns[0], 200);
    const checkBucket = bucket(columns[1]);
    if (!name || !checkBucket) continue;
    const duration = trimmed(columns[2], 40);
    const link = externalLink(columns[3]);
    const description = trimmed(columns[4]);
    const check = {
      name,
      bucket: checkBucket,
      ...(duration && duration !== "0" ? { duration } : {}),
      ...(link ? { link } : {}),
      ...(description ? { description } : {}),
    } satisfies GitHubCheck;
    const identity = link || name;
    if (byIdentity.has(identity)) byIdentity.delete(identity);
    byIdentity.set(identity, check);
  }
  return [...byIdentity.values()].slice(-MAX_CHECKS);
}

export function parseGitHubActionsSnapshot(input: {
  readonly command: unknown;
  readonly output?: unknown;
}): GitHubActionsSnapshot | null {
  const command = commandText(input.command);
  if (!command || !isGitHubPrChecksCommand(command)) return null;

  const watching = /(?:^|\s)--watch(?:\s|$)|(?:^|\s)-[^\s]*w[^\s]*(?:\s|$)/i.test(command);
  const rawOutput = typeof input.output === "string" ? input.output : "";
  const output = rawOutput
    .slice(-MAX_OUTPUT_LENGTH)
    .replace(ANSI_CSI_SEQUENCE, "")
    .replace(/\r/g, "\n");
  const checks = parseJsonChecks(output) ?? parseTableChecks(output);
  return { kind: "pr-checks", watching, checks };
}
