import { T3_REPOSITORY, withoutGuidance } from "./KnownIssueSearch.ts";

/** Browsers and GitHub both choke well before this; the form is pre-filled, not complete. */
export const MAX_REPORT_URL_CHARS = 6_000;
const MAX_TITLE_FAILURE_CHARS = 80;
const MAX_TITLE_SOURCE_CHARS = 1_000;
const TITLE_PREFIX = "[Bug]: ";

/** Ids, paths, and URLs say nothing about the kind of failure and clutter a title. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_PATTERN = /https?:\/\/\S+/gi;
const PATH_PATTERN = /(?:[A-Za-z]:\\|~\/|\.{1,2}\/|\/)[^\s"'`]+/g;
const LONG_ID = /\b(?:[0-9a-f]{8,}|[A-Za-z0-9_-]{24,})\b/g;
/** `provider-turn:abc` style ids, and any token with digits long enough to be a key or id. */
const TOKEN = /\S+/g;
const BEARER = /\bbearer\s+\S+/gi;
const QUOTED = /(["'`])[^"'`\n]{1,200}\1/g;

/** A failure message without guidance, ids, paths, URLs, or quoted values, cut to title length. */
export function titleFromFailure(message: string): string {
  // A title is a few words, so the start of a long message is all that is read.
  const stripped = withoutGuidance(message.slice(0, MAX_TITLE_SOURCE_CHARS))
    .replace(URL_PATTERN, "")
    .replace(UUID, "")
    .replace(QUOTED, "")
    .replace(PATH_PATTERN, "")
    .replace(BEARER, "")
    .replace(TOKEN, (token) =>
      /\w:\w/.test(token) || (token.length >= 6 && /\d/.test(token)) ? "" : token,
    )
    .replace(LONG_ID, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:;])/g, "$1")
    .trim();
  return stripped.length <= MAX_TITLE_FAILURE_CHARS
    ? stripped
    : `${stripped.slice(0, MAX_TITLE_FAILURE_CHARS - 3).trimEnd()}...`;
}

export interface ProviderFailureReportInput {
  readonly failureMessage: string;
  /** The model's reading of the failure, offered to the reporter as a starting point. */
  readonly summary: string;
  readonly driver: string | null;
  readonly providerInstanceId: string;
  readonly model: string | null;
  readonly runtimeMode: string;
  /** The machine running the provider. */
  readonly platform: string;
  readonly serverVersion: string | null;
}

/**
 * A link to GitHub's bug form with the failure filled in. Nothing is sent
 * anywhere: the user reviews the form and submits it themselves. Fields are
 * the issue form's ids in `.github/ISSUE_TEMPLATE/bug_report.yml`. The text
 * of `actual` shrinks first when the link would be too long, and null means
 * no link of a usable length exists.
 */
export function buildProviderFailureReportUrl(input: ProviderFailureReportInput): string | null {
  const failure = titleFromFailure(input.failureMessage);
  const title = `${TITLE_PREFIX}${failure.length > 0 ? failure : titleFromFailure(input.summary) || "Provider error"}`;
  const environment = [
    `Provider: ${input.driver ?? input.providerInstanceId}`,
    `Model: ${input.model ?? "unknown"}`,
    `Runtime mode: ${input.runtimeMode}`,
    `OS: ${input.platform}`,
  ].join(", ");
  const url = (actual: string) => {
    const params: ReadonlyArray<readonly [string, string]> = [
      ["template", "bug_report.yml"],
      ["title", title],
      ["actual", actual],
      ["environment", environment],
      ...(input.serverVersion === null ? [] : ([["version", input.serverVersion]] as const)),
    ];
    return `https://github.com/${T3_REPOSITORY}/issues/new?${params
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&")}`;
  };

  let actual = [
    "Error message:",
    input.failureMessage.trim(),
    "",
    "What happened (explained by a text generation model, so it may be wrong):",
    input.summary.trim(),
  ].join("\n");
  let result = url(actual);
  while (result.length > MAX_REPORT_URL_CHARS && actual.length > 0) {
    actual =
      actual.length < 40 ? "" : `${actual.slice(0, Math.floor(actual.length * 0.8)).trimEnd()}...`;
    result = url(actual);
  }
  return result.length <= MAX_REPORT_URL_CHARS ? result : null;
}
