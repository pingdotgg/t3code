import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const QA_VERDICTS = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "SKIPPED"] as const;
export const QaVerdict = Schema.Literals(QA_VERDICTS);
export type QaVerdict = typeof QaVerdict.Type;

export const QaBugSeverity = Schema.Literals(["critical", "major", "minor", "trivial"]);
export type QaBugSeverity = typeof QaBugSeverity.Type;

export const QaRunId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9-]+$/),
);
export type QaRunId = typeof QaRunId.Type;

const QaText = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** What the agent reports for one scenario; the server adds the evidence. */
export const QaEvidenceRecordInput = Schema.Struct({
  scenario: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  verdict: QaVerdict,
  note: QaText(4000),
  expected: Schema.optional(QaText(2000)),
  actual: Schema.optional(QaText(2000)),
  severity: Schema.optional(QaBugSeverity),
  steps: Schema.optional(Schema.Array(QaText(500)).check(Schema.isMaxLength(30))),
});
export type QaEvidenceRecordInput = typeof QaEvidenceRecordInput.Type;

export const QaFailedRequest = Schema.Struct({
  method: Schema.String,
  url: Schema.String,
  status: Schema.NullOr(Schema.Number),
  errorText: Schema.optional(Schema.String),
});
export type QaFailedRequest = typeof QaFailedRequest.Type;

export const QaScenario = Schema.Struct({
  index: NonNegativeInt,
  scenario: Schema.String,
  verdict: QaVerdict,
  /** Set when the server downgraded the agent's verdict, for example for missing evidence. */
  requestedVerdict: Schema.optional(QaVerdict),
  downgradeReason: Schema.optional(Schema.String),
  note: Schema.String,
  expected: Schema.optional(Schema.String),
  actual: Schema.optional(Schema.String),
  severity: Schema.optional(QaBugSeverity),
  steps: Schema.Array(Schema.String),
  pageUrl: Schema.NullOr(Schema.String),
  pageTitle: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
  /** Where this scenario starts in the run's video, when one was recording. */
  videoOffsetMs: Schema.NullOr(NonNegativeInt),
  screenshotPath: Schema.NullOr(Schema.String),
  consolePath: Schema.NullOr(Schema.String),
  networkPath: Schema.NullOr(Schema.String),
  consoleErrorCount: NonNegativeInt,
  failedRequestCount: NonNegativeInt,
  /** The first few, so the panel can show them without reading the log files. */
  consoleErrors: Schema.Array(Schema.String),
  failedRequests: Schema.Array(QaFailedRequest),
});
export type QaScenario = typeof QaScenario.Type;

export const QaRunVideo = Schema.Struct({
  path: Schema.String,
  sizeBytes: NonNegativeInt,
});
export type QaRunVideo = typeof QaRunVideo.Type;

export const QaRun = Schema.Struct({
  runId: QaRunId,
  threadId: ThreadId,
  site: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  dir: Schema.String,
  scenarios: Schema.Array(QaScenario),
  recordingStartedAt: Schema.NullOr(Schema.String),
  video: Schema.NullOr(QaRunVideo),
  /** Why there is no video, so a report never leaves it out silently. */
  videoUnavailableReason: Schema.NullOr(Schema.String),
  reportMarkdownPath: Schema.NullOr(Schema.String),
  reportHtmlPath: Schema.NullOr(Schema.String),
});
export type QaRun = typeof QaRun.Type;

export const QaRunsSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type QaRunsSubscribeInput = typeof QaRunsSubscribeInput.Type;

/** Newest run first. */
export const QaRunsSnapshot = Schema.Struct({ runs: Schema.Array(QaRun) });
export type QaRunsSnapshot = typeof QaRunsSnapshot.Type;

export const QaRunDeleteInput = Schema.Struct({ threadId: ThreadId, runId: QaRunId });
export type QaRunDeleteInput = typeof QaRunDeleteInput.Type;

export const QaRunDeleteResult = Schema.Struct({ runId: QaRunId });
export type QaRunDeleteResult = typeof QaRunDeleteResult.Type;

export class QaRunError extends Schema.TaggedError<QaRunError>()("QaRunError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
