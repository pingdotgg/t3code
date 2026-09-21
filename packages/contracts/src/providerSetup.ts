import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderSetupInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderSetupInput = typeof ProviderSetupInput.Type;

const SetupOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ProviderAuthMethod = Schema.Struct({
  id: SetupOperationId,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  type: Schema.Literals(["agent", "terminal", "credentials"]),
});
export type ProviderAuthMethod = typeof ProviderAuthMethod.Type;

// These describe client interactions, not OAuth grant types. The provider
// adapter remains responsible for credentials, callbacks, and refresh.
export const ProviderAuthInteraction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("browser"),
    id: SetupOperationId,
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
    requiresConsent: Schema.Boolean,
    acceptsCallback: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("deviceCode"),
    id: SetupOperationId,
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
    userCode: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    id: SetupOperationId,
    output: Schema.String.check(Schema.isMaxLength(16_384)),
  }),
  Schema.Struct({
    type: Schema.Literal("credentials"),
    id: SetupOperationId,
    fields: Schema.Array(
      Schema.Struct({
        name: SetupOperationId,
        label: TrimmedNonEmptyString,
        secret: Schema.Boolean,
      }),
    ).check(Schema.isMaxLength(16)),
  }),
]);
export type ProviderAuthInteraction = typeof ProviderAuthInteraction.Type;

export const ProviderAuthResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("browser"),
    action: Schema.Literals(["accept", "decline"]),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    data: Schema.String.check(Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    type: Schema.Literal("credentials"),
    values: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(16_384))),
  }),
]);
export type ProviderAuthResponse = typeof ProviderAuthResponse.Type;

export const ProviderAuthStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  methodId: Schema.optionalKey(SetupOperationId),
});
export type ProviderAuthStartInput = typeof ProviderAuthStartInput.Type;

export const ProviderAuthRespondInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
  interactionId: SetupOperationId,
  response: ProviderAuthResponse,
});
export type ProviderAuthRespondInput = typeof ProviderAuthRespondInput.Type;

export const ProviderAuthState = Schema.Struct({
  instanceId: ProviderInstanceId,
  phase: Schema.Literals([
    "idle",
    "starting",
    "waiting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  flowId: Schema.NullOr(SetupOperationId),
  authorizationUrl: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
  methods: Schema.optionalKey(Schema.Array(ProviderAuthMethod).check(Schema.isMaxLength(32))),
  interaction: Schema.optionalKey(Schema.NullOr(ProviderAuthInteraction)),
  credentialOwner: Schema.optionalKey(Schema.Literals(["provider", "t3"])),
});
export type ProviderAuthState = typeof ProviderAuthState.Type;

export const ProviderAuthCompleteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type ProviderAuthCompleteInput = typeof ProviderAuthCompleteInput.Type;

export const ProviderAuthCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
});
export type ProviderAuthCancelInput = typeof ProviderAuthCancelInput.Type;

const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProviderInstallState = Schema.Struct({
  driver: ProviderDriverKind,
  operationId: Schema.NullOr(SetupOperationId),
  phase: Schema.Literals([
    "idle",
    "downloading",
    "extracting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  downloadedBytes: ByteCount,
  totalBytes: Schema.NullOr(ByteCount),
  version: Schema.NullOr(TrimmedNonEmptyString),
  installedVersion: Schema.NullOr(TrimmedNonEmptyString),
  canRemove: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ProviderInstallState = typeof ProviderInstallState.Type;

export const ProviderInstallCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: SetupOperationId,
});
export type ProviderInstallCancelInput = typeof ProviderInstallCancelInput.Type;

/** Safe setup failure text. Never include OAuth codes, URLs, or native token data. */
export class ProviderSetupError extends Schema.TaggedError<ProviderSetupError>()(
  "ProviderSetupError",
  {
    instanceId: ProviderInstanceId,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
