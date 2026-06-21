import * as Schema from "effect/Schema";

export const RelayClientStatusSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    executablePath: Schema.String,
    source: Schema.Literals(["override", "managed", "path"]),
    version: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("missing"),
    version: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    platform: Schema.String,
    arch: Schema.String,
    version: Schema.String,
  }),
]);
export type RelayClientStatus = typeof RelayClientStatusSchema.Type;

export const RelayClientInstallProgressStageSchema = Schema.Literals([
  "checking",
  "waiting_for_lock",
  "downloading",
  "verifying",
  "installing",
  "validating",
  "activating",
]);
export type RelayClientInstallProgressStage = typeof RelayClientInstallProgressStageSchema.Type;

export const RelayClientInstallProgressEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: RelayClientInstallProgressStageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    status: RelayClientStatusSchema,
  }),
]);
export type RelayClientInstallProgressEvent = typeof RelayClientInstallProgressEventSchema.Type;

export const RelayClientInstallFailureReasonSchema = Schema.Literals([
  "download_failed",
  "invalid_checksum",
  "install_locked",
  "override_missing",
  "unsupported_platform",
  "validation_failed",
  "write_failed",
]);
export type RelayClientInstallFailureReason = typeof RelayClientInstallFailureReasonSchema.Type;

export class RelayClientInstallFailedError extends Schema.TaggedErrorClass<RelayClientInstallFailedError>()(
  "RelayClientInstallFailedError",
  {
    reason: RelayClientInstallFailureReasonSchema,
  },
) {
  // `cause` is intentionally retained only on the server-side error instance. It is not part of
  // the RPC schema, so internal installation details cannot cross the transport boundary.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: RelayClientInstallFailureReason;
    readonly cause?: unknown;
  }) {
    super({ reason: props.reason });
    if (props.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: props.cause,
        configurable: true,
        writable: true,
      });
    }
  }

  override get message(): string {
    return `Relay client installation failed (${this.reason}).`;
  }
}
