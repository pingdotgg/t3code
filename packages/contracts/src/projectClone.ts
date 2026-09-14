import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  SourceControlCloneProtocol,
  SourceControlProviderKind,
  SourceControlRepositoryInfo,
} from "./sourceControl.ts";

/**
 * Live progress of a repository clone that backs a freshly added project. The
 * server keeps this in memory only: a finished clone is dropped after a short
 * grace period, a failed one stays until it is retried or the project is
 * removed, and a server restart forgets in-flight clones (the project keeps
 * its empty workspace root and can be removed like any other project).
 */
/** Producers clamp free text to these before publishing so encoding never fails. */
export const PROJECT_CLONE_DETAIL_MAX_LENGTH = 200;
export const PROJECT_CLONE_ERROR_MAX_LENGTH = 1000;

/** Follows git's own clone phases as they appear on stderr, in order. */
export const ProjectCloneStage = Schema.Literals([
  "connecting",
  "counting",
  "receiving",
  "resolving",
  "checkout",
]);
export type ProjectCloneStage = typeof ProjectCloneStage.Type;

export const ProjectClonePhase = Schema.Literals(["running", "done", "failed", "cancelled"]);
export type ProjectClonePhase = typeof ProjectClonePhase.Type;

export const ProjectCloneSnapshot = Schema.Struct({
  projectId: ProjectId,
  remoteUrl: TrimmedNonEmptyString,
  destinationPath: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
  phase: ProjectClonePhase,
  stage: ProjectCloneStage,
  /** Percent of the current stage, parsed from git's progress lines. */
  percent: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  /** Trailing text from the progress line, typically transfer size and rate. */
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(PROJECT_CLONE_DETAIL_MAX_LENGTH))),
  /** Human readable reason when phase is failed. */
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(PROJECT_CLONE_ERROR_MAX_LENGTH))),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  sequence: NonNegativeInt,
});
export type ProjectCloneSnapshot = typeof ProjectCloneSnapshot.Type;

export const ProjectCloneSubscribeInput = Schema.Struct({});
export type ProjectCloneSubscribeInput = typeof ProjectCloneSubscribeInput.Type;

/** Every tracked clone on the environment. Sent first, then after every change. */
export const ProjectCloneListEvent = Schema.Array(ProjectCloneSnapshot);
export type ProjectCloneListEvent = typeof ProjectCloneListEvent.Type;

export const ProjectCloneStartInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type ProjectCloneStartInput = typeof ProjectCloneStartInput.Type;

export const ProjectCloneStartResult = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type ProjectCloneStartResult = typeof ProjectCloneStartResult.Type;

export const ProjectCloneActionInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectCloneActionInput = typeof ProjectCloneActionInput.Type;

export const ProjectCloneActionResult = Schema.Struct({
  applied: Schema.Boolean,
});
export type ProjectCloneActionResult = typeof ProjectCloneActionResult.Type;

export function projectCloneStageLabel(stage: ProjectCloneStage): string {
  switch (stage) {
    case "connecting":
      return "Connecting";
    case "counting":
      return "Counting objects";
    case "receiving":
      return "Receiving objects";
    case "resolving":
      return "Resolving deltas";
    case "checkout":
      return "Checking out files";
  }
}

/** Display name for a clone: the looked-up `owner/repo`, else the folder being cloned into. */
export function projectCloneDisplayName(
  snapshot: Pick<ProjectCloneSnapshot, "repository" | "destinationPath">,
): string {
  if (snapshot.repository) return snapshot.repository.nameWithOwner;
  const segments = snapshot.destinationPath.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? snapshot.destinationPath;
}

/** One-line progress summary: `Receiving objects · 45% · 12.3 MiB | 5.0 MiB/s`. */
export function projectCloneProgressSummary(
  snapshot: Pick<ProjectCloneSnapshot, "stage" | "percent" | "detail">,
): string {
  const parts = [projectCloneStageLabel(snapshot.stage)];
  if (snapshot.percent !== null) parts.push(`${snapshot.percent}%`);
  if (snapshot.detail) parts.push(snapshot.detail);
  return parts.join(" · ");
}
