import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Oldest Blender release the integration accepts: the oldest LTS line still in use. */
export const BLENDER_MINIMUM_VERSION = { major: 4, minor: 2 } as const;

/** Where the probed executable came from: the environment's override, PATH, or a standard install. */
export const BlenderExecutableSource = Schema.Literals(["override", "path", "standard-install"]);
export type BlenderExecutableSource = typeof BlenderExecutableSource.Type;

export const BlenderProbeFailure = Schema.Literals([
  "spawn-failed",
  "timed-out",
  "nonzero-exit",
  "unrecognized-output",
]);
export type BlenderProbeFailure = typeof BlenderProbeFailure.Type;

const probedExecutable = {
  executablePath: TrimmedNonEmptyString,
  source: BlenderExecutableSource,
};

/** Availability of Blender on one environment, from a bounded `--version` probe. */
export const BlenderStatus = Schema.Union([
  Schema.TaggedStruct("Disabled", {}),
  Schema.TaggedStruct("NotFound", {
    source: Schema.Literals(["override", "detection"]),
  }),
  Schema.TaggedStruct("Available", { ...probedExecutable, version: TrimmedNonEmptyString }),
  Schema.TaggedStruct("Unsupported", {
    ...probedExecutable,
    version: TrimmedNonEmptyString,
    minimumVersion: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("ProbeFailed", {
    ...probedExecutable,
    reason: BlenderProbeFailure,
    exitCode: Schema.optionalKey(Schema.Number),
  }),
]);
export type BlenderStatus = typeof BlenderStatus.Type;

const BLENDER_PATH_MAX_LENGTH = 1024;
/** Most objects an inspection returns; the count still covers the whole scene. */
export const BLENDER_INSPECT_MAX_OBJECTS = 200;
/** Longest a job may run, and the default when a request names none. */
const BLENDER_JOB_MAX_TIMEOUT_SECONDS = 30 * 60;
export const BLENDER_JOB_DEFAULT_TIMEOUT_SECONDS = 10 * 60;

/** A path inside the thread's workspace, relative to its root. */
const BlenderWorkspacePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BLENDER_PATH_MAX_LENGTH),
);

export const BlenderJobId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("BlenderJobId"),
);
export type BlenderJobId = typeof BlenderJobId.Type;

/** A `.blend` file in the thread's workspace. */
export const BlenderSceneInput = Schema.Struct({
  threadId: ThreadId,
  path: BlenderWorkspacePath,
});
export type BlenderSceneInput = typeof BlenderSceneInput.Type;

export const BlenderOpenSceneInput = Schema.Struct({
  ...BlenderSceneInput.fields,
  /** Starts a new export when this version's last one failed. */
  retry: Schema.optionalKey(Schema.Boolean),
});
export type BlenderOpenSceneInput = typeof BlenderOpenSceneInput.Type;

export const BlenderSceneObject = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  dimensions: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  selected: Schema.Boolean,
});
export type BlenderSceneObject = typeof BlenderSceneObject.Type;

/** A concise scene summary; full scene data stays on the environment. */
export const BlenderScene = Schema.Struct({
  path: Schema.String,
  objects: Schema.Array(BlenderSceneObject),
  objectCount: NonNegativeInt,
});
export type BlenderScene = typeof BlenderScene.Type;

/** `preview` is a GLB the viewer shows; `render` is a still PNG from the scene camera. */
export const BlenderJobOutput = Schema.Literals(["preview", "render"]);
export type BlenderJobOutput = typeof BlenderJobOutput.Type;

export const BlenderStartJobInput = Schema.Struct({
  threadId: ThreadId,
  /** The `.blend` to start from. Blender opens a private copy, so this file is never written. */
  input: Schema.optionalKey(BlenderWorkspacePath),
  /** A Python script run inside Blender before outputs are written, with the user's privileges. */
  script: Schema.optionalKey(BlenderWorkspacePath),
  outputs: Schema.Array(BlenderJobOutput).check(Schema.isMaxLength(2)),
  /** A new `.blend` path for the edited scene, written only when the job succeeds. */
  saveAs: Schema.optionalKey(BlenderWorkspacePath),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BLENDER_JOB_MAX_TIMEOUT_SECONDS })),
  ),
});
export type BlenderStartJobInput = typeof BlenderStartJobInput.Type;

export const BlenderJobRef = Schema.Struct({ threadId: ThreadId, jobId: BlenderJobId });
export type BlenderJobRef = typeof BlenderJobRef.Type;

export const BlenderSubscribeJobsInput = Schema.Struct({ threadId: ThreadId });
export type BlenderSubscribeJobsInput = typeof BlenderSubscribeJobsInput.Type;

export const BlenderJobFailureReason = Schema.Literals([
  "unavailable",
  "spawn-failed",
  "script-error",
  "timed-out",
  "output-missing",
  "output-too-large",
  "save-target-exists",
]);
export type BlenderJobFailureReason = typeof BlenderJobFailureReason.Type;

/**
 * One job's state. `sequence` orders jobs on the environment; a preview is `current` while no
 * later job of the same thread and source has published one.
 */
export const BlenderJob = Schema.Struct({
  id: BlenderJobId,
  threadId: ThreadId,
  sequence: NonNegativeInt,
  input: Schema.optionalKey(Schema.String),
  script: Schema.optionalKey(Schema.String),
  outputs: Schema.Array(BlenderJobOutput),
  saveAs: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
  startedAt: Schema.optionalKey(Schema.Number),
  finishedAt: Schema.optionalKey(Schema.Number),
  status: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
  /** Finished outputs. A complete preview is available while the job is still running. */
  result: Schema.optionalKey(
    Schema.Struct({
      preview: Schema.optionalKey(
        Schema.Struct({ bytes: NonNegativeInt, current: Schema.Boolean, revision: NonNegativeInt }),
      ),
      render: Schema.optionalKey(Schema.Struct({ bytes: NonNegativeInt })),
      saved: Schema.optionalKey(Schema.String),
    }),
  ),
  failure: Schema.optionalKey(
    Schema.Struct({
      reason: BlenderJobFailureReason,
      message: Schema.String,
      exitCode: Schema.optionalKey(Schema.Number),
    }),
  ),
  /** `replaced`: an automatic preview export the file's newer version superseded. */
  cancelledBy: Schema.optionalKey(Schema.Literals(["request", "thread-stopped", "replaced"])),
});
export type BlenderJob = typeof BlenderJob.Type;

export const isBlenderJobTerminal = (job: Pick<BlenderJob, "status">) =>
  job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";

/** A thread's retained jobs first, then each job as it changes. */
export const BlenderJobEvent = Schema.Union([
  Schema.TaggedStruct("Snapshot", { jobs: Schema.Array(BlenderJob) }),
  Schema.TaggedStruct("Updated", { job: BlenderJob }),
  Schema.TaggedStruct("Removed", { threadId: ThreadId, jobId: BlenderJobId }),
]);
export type BlenderJobEvent = typeof BlenderJobEvent.Type;

export const BlenderRequestErrorReason = Schema.Literals([
  "disabled",
  "unavailable",
  "invalid-request",
  "thread-not-found",
  "path-not-allowed",
  "file-not-found",
  "save-target-exists",
  "too-many-jobs",
  "job-not-found",
  "inspection-failed",
]);
export type BlenderRequestErrorReason = typeof BlenderRequestErrorReason.Type;

export class BlenderRequestError extends Schema.TaggedError<BlenderRequestError>()(
  "BlenderRequestError",
  {
    reason: BlenderRequestErrorReason,
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Blender: ${this.reason}.`
      : `Blender: ${this.reason}: ${this.detail}`;
  }
}
