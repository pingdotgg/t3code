import type {
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
  QaEvidenceRecordInput,
  QaFailedRequest,
  QaVerdict,
} from "@t3tools/contracts";

export const QA_MAX_SCENARIOS_PER_RUN = 200;
export const QA_MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
export const QA_MAX_LOG_ENTRIES = 500;
const MAX_LOG_TEXT_CHARS = 4000;
const MAX_SUMMARY_ITEMS = 5;

const REDACTED = "REDACTED";
const SENSITIVE_PARAM =
  /token|secret|passw|pwd|api[-_]?key|^key$|^auth|credential|session|^sid$|^sig$|signature|^code$|jwt|cookie/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const HEADER_VALUE =
  /\b(authorization|proxy-authorization|cookie|set-cookie)(\s*[:=]\s*)[^\n\r;,]+/gi;

const cut = (text: string, max = MAX_LOG_TEXT_CHARS) =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

export function redactText(text: string): string {
  return text
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(
      HEADER_VALUE,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    );
}

function redactParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const name of new Set(params.keys())) {
    if (SENSITIVE_PARAM.test(name)) {
      params.set(name, REDACTED);
      changed = true;
    }
  }
  return changed;
}

/** Removes credentials a URL can carry: user info, and sensitive query or fragment parameters. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return redactText(raw);
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  if (redactParams(url.searchParams)) url.search = url.searchParams.toString();
  if (url.hash.includes("=")) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (redactParams(fragment)) url.hash = fragment.toString();
  }
  return url.toString();
}

/** Picks known fields only, so headers or bodies a future host adds never reach disk. */
export function sanitizeConsoleEntries(entries: ReadonlyArray<PreviewAutomationConsoleEntry>) {
  return entries.slice(-QA_MAX_LOG_ENTRIES).map((entry) => ({
    level: entry.level,
    text: cut(redactText(entry.text)),
    timestamp: entry.timestamp,
    ...(entry.source === undefined ? {} : { source: cut(redactUrl(entry.source), 2048) }),
  }));
}

export function sanitizeNetworkEntries(entries: ReadonlyArray<PreviewAutomationNetworkEntry>) {
  return entries.slice(-QA_MAX_LOG_ENTRIES).map((entry) => ({
    url: cut(redactUrl(entry.url), 2048),
    method: entry.method,
    status: entry.status,
    failed: entry.failed,
    ...(entry.errorText === undefined ? {} : { errorText: cut(redactText(entry.errorText), 500) }),
    timestamp: entry.timestamp,
  }));
}

const isConsoleError = (entry: { readonly level: string }) => /^(error|assert)$/i.test(entry.level);
const isFailedRequest = (entry: { readonly failed: boolean; readonly status: number | null }) =>
  entry.failed || (entry.status !== null && entry.status >= 400);

// An unparseable timestamp counts as new: better a stale error than a hidden one.
const after = (since: string | null) => (timestamp: string) =>
  since === null || !(Date.parse(timestamp) <= Date.parse(since));

/** Counts only what happened after `since`, the previous verdict; the log files keep everything. */
export function summarizeLogs(
  consoleEntries: ReturnType<typeof sanitizeConsoleEntries>,
  networkEntries: ReturnType<typeof sanitizeNetworkEntries>,
  since: string | null,
) {
  const isNew = after(since);
  const errors = consoleEntries.filter((entry) => isConsoleError(entry) && isNew(entry.timestamp));
  const failed = networkEntries.filter((entry) => isFailedRequest(entry) && isNew(entry.timestamp));
  return {
    consoleErrorCount: errors.length,
    failedRequestCount: failed.length,
    consoleErrors: errors.slice(0, MAX_SUMMARY_ITEMS).map((entry) => cut(entry.text, 300)),
    failedRequests: failed.slice(0, MAX_SUMMARY_ITEMS).map((entry): QaFailedRequest => ({
      method: entry.method,
      url: entry.url,
      status: entry.status,
      ...(entry.errorText === undefined ? {} : { errorText: entry.errorText }),
    })),
  };
}

/** A PASS or FAIL must be backed by a screenshot; without one it can only be INCONCLUSIVE. */
export function resolveVerdict(
  requested: QaVerdict,
  hasScreenshot: boolean,
): { readonly verdict: QaVerdict; readonly downgradeReason?: string } {
  if ((requested === "PASS" || requested === "FAIL") && !hasScreenshot) {
    return {
      verdict: "INCONCLUSIVE",
      downgradeReason: `Recorded as ${requested}, but no screenshot could be captured as evidence.`,
    };
  }
  return { verdict: requested };
}

export function stepsFor(
  input: Pick<QaEvidenceRecordInput, "steps">,
  timeline: ReadonlyArray<PreviewAutomationActionEvent>,
  since: string | null,
): ReadonlyArray<string> {
  if (input.steps !== undefined && input.steps.length > 0)
    return input.steps.map((step) => redactText(step));
  const isNew = after(since);
  return timeline
    .filter((event) => isNew(event.startedAt))
    .slice(-20)
    .map((event) => `${event.action}${event.status === "succeeded" ? "" : ` (${event.status})`}`);
}

export function scenarioFileStem(index: number, scenario: string): string {
  const slug =
    scenario
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "scenario";
  return `${String(index + 1).padStart(2, "0")}-${slug}`;
}
