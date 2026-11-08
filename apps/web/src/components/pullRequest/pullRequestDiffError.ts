import { type TimestampFormat } from "@t3tools/contracts/settings";

import { formatUpcomingTimestamp } from "../../timestampFormat";

const RATE_LIMIT = /\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/iu;
/** Matches the ISO resume time source-control rate-limit errors embed. */
const RESUME_AT =
  /Requests resume at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/iu;

function sourceControlRateLimitResumeAt(error: string): string | undefined {
  return error.match(RESUME_AT)?.[1];
}

/** Epoch ms for `useNowAfter`, so the empty state can drop a past resume time. */
export function sourceControlRateLimitResumeDeadlineMs(error: string): number | null {
  const iso = sourceControlRateLimitResumeAt(error);
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function formatSourceControlRateLimitResume(
  resumeAtIso: string,
  timestampFormat: TimestampFormat,
  nowMs: number,
): string | null {
  const resumeMs = Date.parse(resumeAtIso);
  if (!Number.isFinite(resumeMs) || resumeMs <= nowMs) return null;
  const when = formatUpcomingTimestamp(resumeAtIso, timestampFormat, nowMs);
  return when.length > 0 ? `Resumes ${when}` : null;
}

function rateLimitRetryAfter(
  resumeAtIso: string | undefined,
  timestampFormat: TimestampFormat,
  nowMs: number,
): string | null {
  if (resumeAtIso === undefined) return "after the limit resets";
  const resumeMs = Date.parse(resumeAtIso);
  if (!Number.isFinite(resumeMs)) return "after the limit resets";
  if (resumeMs <= nowMs) return null;
  const when = formatUpcomingTimestamp(resumeAtIso, timestampFormat, nowMs);
  if (when.length === 0) return "after the limit resets";
  return when.startsWith("tomorrow") || when.includes(" at ") ? when : `at ${when}`;
}

/** Diff failures currently include transport wrappers, so recognize the reason inside them. */
export function describePullRequestDiffError(
  error: string,
  providerName: string,
  term: string,
  timestampFormat: TimestampFormat = "12-hour",
  nowMs: number = Date.now(),
) {
  if (RATE_LIMIT.test(error)) {
    const after = rateLimitRetryAfter(
      sourceControlRateLimitResumeAt(error),
      timestampFormat,
      nowMs,
    );
    return {
      title: `${providerName} rate limit reached`,
      description:
        after === null
          ? `${providerName} is temporarily limiting requests, so this diff couldn't be loaded. Try again, or view the changes on ${providerName}.`
          : `${providerName} is temporarily limiting requests, so this diff couldn't be loaded. Try again ${after}, or view the changes on ${providerName}.`,
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
  nowMs: number = Date.now(),
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
  const resume = formatSourceControlRateLimitResume(resumeAt, timestampFormat, nowMs);
  return resume === null ? withoutResume : `${withoutResume}. ${resume}.`;
}
