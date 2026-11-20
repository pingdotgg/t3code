import {
  ChatImageAttachment,
  ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./chatAttachment.ts";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

export const RuntimeMode = Schema.Literals([
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "workspace-write",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const SparrowRuntimeMode = Schema.Literals(["read-only", "workspace-write", "full-access"]);
export type SparrowRuntimeMode = typeof SparrowRuntimeMode.Type;
export const DEFAULT_SPARROW_RUNTIME_MODE: SparrowRuntimeMode = "workspace-write";

/** Resolves the default runtime mode for `driverKind`, using Sparrow's dedicated default when Sparrow is active. */
export function defaultRuntimeModeForProvider(input: {
  readonly driverKind: string | undefined;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly sparrowDefaultRuntimeMode: SparrowRuntimeMode;
}): RuntimeMode {
  return input.driverKind === "sparrow"
    ? input.sparrowDefaultRuntimeMode
    : input.defaultRuntimeMode;
}

/** Clamps a Sparrow default mode under a managed ceiling without escaping Sparrow's three modes. */
export function clampSparrowRuntimeMode(
  mode: SparrowRuntimeMode,
  ceiling: RuntimeMode,
): SparrowRuntimeMode {
  if (!isRuntimeModeAbove(mode, ceiling)) return mode;
  return isRuntimeModeAbove("workspace-write", ceiling) ? "read-only" : "workspace-write";
}

export const CLASSIC_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;
export type ClassicRuntimeMode = (typeof CLASSIC_RUNTIME_MODES)[number];

export const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "read-only": 0,
  "approval-required": 1,
  "auto-accept-edits": 2,
  "workspace-write": 2,
  auto: 3,
  "full-access": 4,
};

/** Whether `mode` grants the agent more than `ceiling`; no ceiling allows every mode. */
export const isRuntimeModeAbove = (mode: RuntimeMode, ceiling: RuntimeMode | undefined): boolean =>
  ceiling !== undefined && RUNTIME_MODE_RANK[mode] > RUNTIME_MODE_RANK[ceiling];

/** Resolves `runtimeMode` into the closest supported mode for a provider. */
export function compatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  if (
    supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
  ) {
    return runtimeMode;
  }
  if (supportedRuntimeModes.includes("approval-required")) {
    return "approval-required";
  }
  if (runtimeMode !== "read-only" && supportedRuntimeModes.includes("workspace-write")) {
    return "workspace-write";
  }
  return supportedRuntimeModes[0] ?? runtimeMode;
}

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;

export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;

// Why an approval reached the user although the thread runs with full access:
// the user's own ask rule, or a check the provider enforces even when bypassed.
export const ProviderApprovalFullAccessOverride = Schema.Literals(["ask_rule", "provider_check"]);
export type ProviderApprovalFullAccessOverride = typeof ProviderApprovalFullAccessOverride.Type;

export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

export const UserInputAttachmentAnswerPayload = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
});
export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
