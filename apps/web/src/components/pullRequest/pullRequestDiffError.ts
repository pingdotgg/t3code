import { type TimestampFormat } from "@t3tools/contracts/settings";

import { formatUpcomingTimestamp } from "../../timestampFormat";

const RATE_LIMIT = /\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/iu;
/** Matches the ISO resume time source-control rate-limit errors embed. */
const RESUME_AT =
  /Requests resume at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/iu;

function sourceControlRateLimitResumeAt(error: string): string | undefined {
  return error.match(RESUME_AT)?.[1];
}

function formatSourceControlRateLimitResume(
  resumeAtIso: string,
  timestampFormat: TimestampFormat,
): string {
  const when = formatUpcomingTimestamp(resumeAtIso, timestampFormat);
  return when.length > 0 ? `Resumes ${when}` : "Resumes when the limit resets";
}

/** Diff failures currently include transport wrappers, so recognize the reason inside them. */
export function describePullRequestDiffError(
  error: string,
  providerName: string,
  term: string,
  timestampFormat: TimestampFormat = "12-hour",
) {
  if (RATE_LIMIT.test(error)) {
    const resumeAt = sourceControlRateLimitResumeAt(error);
    return {
      title: `${providerName} rate limit reached`,
      // Same shape as the usage-limit banner: the resume time is the description.
      description:
        resumeAt === undefined
          ? `${providerName} is temporarily limiting requests. Try again after the limit resets, or view the changes on ${providerName}.`
          : formatSourceControlRateLimitResume(resumeAt, timestampFormat),
    };
  }

  return {
    title: "Couldn't load the changes",
    description: `The environment couldn't load this ${term}'s diff. Try again, or view the changes on ${providerName}.`,
  };
}

/** List and host errors show raw detail; rewrite rate limits so the resume time is readable. */
export function describeSourceControlRateLimitError(
  error: string,
  timestampFormat: TimestampFormat = "12-hour",
): string {
  if (!RATE_LIMIT.test(error)) return error;
  const resumeAt = sourceControlRateLimitResumeAt(error);
  if (resumeAt === undefined) return error;
  const withoutResume = error
    .replace(RESUME_AT, "")
    .replace(/\s+/gu, " ")
    .replace(/\.\s*\./gu, ".")
    .replace(/^\.\s*/u, "")
    .replace(/\s*\.\s*$/u, "")
    .trim();
  return `${withoutResume}. ${formatSourceControlRateLimitResume(resumeAt, timestampFormat)}.`;
}
