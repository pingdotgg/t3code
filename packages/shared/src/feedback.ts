const FEEDBACK_ISSUE_CHOOSER_URL = "https://github.com/pingdotgg/t3code/issues/new/choose";

export interface FeedbackEnvironment {
  readonly appVersion: string;
  readonly surface: string;
  readonly platform: string;
}

function normalizedDetail(value: string, fallback: string): string {
  return value.trim() || fallback;
}

export function buildFeedbackIssueUrl(environment: FeedbackEnvironment): string {
  const appVersion = normalizedDetail(environment.appVersion, "Unknown");
  const surface = normalizedDetail(environment.surface, "T3 Code");
  const platform = normalizedDetail(environment.platform, "Unknown");
  const environmentSummary = `${surface}; ${platform}`;
  const body = [
    "## T3 Code environment",
    "",
    `- Version: ${appVersion}`,
    `- Surface: ${surface}`,
    `- Platform: ${platform}`,
    "",
    "<!-- Add your feedback above, then review and edit all details before submitting. -->",
  ].join("\n");

  const url = new URL(FEEDBACK_ISSUE_CHOOSER_URL);
  url.searchParams.set("body", body);
  // GitHub issue forms accept field ids as query parameters. These cover the
  // bug form's environment fields and the feature form's references field.
  url.searchParams.set("version", appVersion);
  url.searchParams.set("environment", environmentSummary);
  url.searchParams.set("references", body);
  return url.toString();
}
