import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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
