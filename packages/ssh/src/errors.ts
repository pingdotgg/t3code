import * as Schema from "effect/Schema";

export class SshHostDiscoveryError extends Schema.TaggedError<SshHostDiscoveryError>()(
  "SshHostDiscoveryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class SshInvalidTargetError extends Schema.TaggedError<SshInvalidTargetError>()(
  "SshInvalidTargetError",
  {
    message: Schema.String,
  },
) {}

export class SshCommandError extends Schema.TaggedError<SshCommandError>()("SshCommandError", {
  message: Schema.String,
  command: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  stdout: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SshLaunchError extends Schema.TaggedError<SshLaunchError>()("SshLaunchError", {
  message: Schema.String,
  stdout: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SshPairingError extends Schema.TaggedError<SshPairingError>()("SshPairingError", {
  message: Schema.String,
  stdout: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SshHttpBridgeError extends Schema.TaggedError<SshHttpBridgeError>()(
  "SshHttpBridgeError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class SshReadinessError extends Schema.TaggedError<SshReadinessError>()(
  "SshReadinessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class SshPasswordPromptError extends Schema.TaggedError<SshPasswordPromptError>()(
  "SshPasswordPromptError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
