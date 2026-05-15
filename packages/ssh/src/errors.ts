import * as Schema from "effect/Schema";

export class SshHostDiscoveryError extends Schema.TaggedErrorClass<SshHostDiscoveryError>()(
  "SshHostDiscoveryError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class SshInvalidTargetError extends Schema.TaggedErrorClass<SshInvalidTargetError>()(
  "SshInvalidTargetError",
  {
    message: Schema.String,
  },
) {}

export class SshCommandError extends Schema.TaggedErrorClass<SshCommandError>()("SshCommandError", {
  message: Schema.String,
  command: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SshLaunchError extends Schema.TaggedErrorClass<SshLaunchError>()("SshLaunchError", {
  message: Schema.String,
  stdout: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SshPairingError extends Schema.TaggedErrorClass<SshPairingError>()("SshPairingError", {
  message: Schema.String,
  stdout: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SshHttpBridgeError extends Schema.TaggedErrorClass<SshHttpBridgeError>()(
  "SshHttpBridgeError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SshReadinessProbeFailedError extends Schema.TaggedErrorClass<SshReadinessProbeFailedError>()(
  "SshReadinessProbeFailedError",
  {
    message: Schema.String,
    requestUrl: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SshReadinessProbeTimedOutError extends Schema.TaggedErrorClass<SshReadinessProbeTimedOutError>()(
  "SshReadinessProbeTimedOutError",
  {
    message: Schema.String,
    requestUrl: Schema.String,
    attempt: Schema.Number,
    probeTimeoutMs: Schema.Number,
  },
) {}

export class SshReadinessTimedOutError extends Schema.TaggedErrorClass<SshReadinessTimedOutError>()(
  "SshReadinessTimedOutError",
  {
    message: Schema.String,
    baseUrl: Schema.String,
    requestUrl: Schema.String,
    timeoutMs: Schema.Number,
    intervalMs: Schema.Number,
    probeTimeoutMs: Schema.Number,
    attempts: Schema.Number,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export type SshReadinessError =
  | SshReadinessProbeFailedError
  | SshReadinessProbeTimedOutError
  | SshReadinessTimedOutError;

const isSshReadinessProbeFailedError = Schema.is(SshReadinessProbeFailedError);
const isSshReadinessProbeTimedOutError = Schema.is(SshReadinessProbeTimedOutError);
const isSshReadinessTimedOutError = Schema.is(SshReadinessTimedOutError);

export function isSshReadinessError(cause: unknown): cause is SshReadinessError {
  return (
    isSshReadinessProbeFailedError(cause) ||
    isSshReadinessProbeTimedOutError(cause) ||
    isSshReadinessTimedOutError(cause)
  );
}

export class SshPasswordPromptError extends Schema.TaggedErrorClass<SshPasswordPromptError>()(
  "SshPasswordPromptError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
