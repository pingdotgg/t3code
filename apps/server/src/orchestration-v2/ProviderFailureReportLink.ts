import { driverKeyword, keywordsForFailure, T3_REPOSITORY } from "./KnownIssueSearch.ts";

/** Browsers and GitHub both choke well before this; the form is pre-filled, not complete. */
export const MAX_REPORT_URL_CHARS = 6_000;
const TITLE_PREFIX = "[Bug]: ";
const GENERIC_TITLE = "Provider failure";
const MIN_TITLE_WORDS = 2;
/** What the form's "Actual behavior" says until the user pastes the details the banner copied. */
export const REPORT_ACTUAL_INSTRUCTION =
  "Paste the error and explanation from the T3 banner here, after checking it for anything private.";

/** The title: only words from the search vocabulary, never any of the error's own text. */
export function reportTitleFromFailure(message: string): string {
  const words = keywordsForFailure(message);
  return `${TITLE_PREFIX}${
    words.length >= MIN_TITLE_WORDS ? `${GENERIC_TITLE}: ${words.join(" ")}` : GENERIC_TITLE
  }`;
}

export interface ProviderFailureReportInput {
  /** Read only to choose title words from the fixed vocabulary. It is never placed in the link. */
  readonly failureMessage: string;
  readonly driver: string | null;
  readonly runtimeMode: string;
  /** The machine running the provider. */
  readonly platform: string;
  readonly serverVersion: string | null;
}

/**
 * A link to GitHub's bug form with only safe, structured data filled in: a
 * title of vocabulary words, the provider, runtime mode and OS, and the version.
 * The error, the explanation and the model name (which can be custom) are not in
 * the link; the client copies them for the user to
 * paste after checking them. Fields are the issue form's ids in
 * `.github/ISSUE_TEMPLATE/bug_report.yml`. Null means no link could be built,
 * which never stops an explanation.
 */
export function buildProviderFailureReportUrl(input: ProviderFailureReportInput): string | null {
  try {
    const environment = [
      `Provider: ${driverKeyword(input.driver) ?? "unknown"}`,
      `Runtime mode: ${input.runtimeMode}`,
      `OS: ${input.platform}`,
    ].join(", ");
    const params: ReadonlyArray<readonly [string, string]> = [
      ["template", "bug_report.yml"],
      ["title", reportTitleFromFailure(input.failureMessage)],
      ["actual", REPORT_ACTUAL_INSTRUCTION],
      ["environment", environment],
      ...(input.serverVersion === null ? [] : ([["version", input.serverVersion]] as const)),
    ];
    // A lone surrogate in a value (a version string) would make encodeURIComponent throw.
    const url = `https://github.com/${T3_REPOSITORY}/issues/new?${params
      .map(([key, value]) => `${key}=${encodeURIComponent(value.toWellFormed())}`)
      .join("&")}`;
    return url.length <= MAX_REPORT_URL_CHARS ? url : null;
  } catch {
    return null;
  }
}
