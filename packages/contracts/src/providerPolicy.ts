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
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/** Whether `mode` grants the agent more than `ceiling`; no ceiling allows every mode. */
export const isRuntimeModeAbove = (mode: RuntimeMode, ceiling: RuntimeMode | undefined): boolean =>
  ceiling !== undefined && RUNTIME_MODE_RANK[mode] > RUNTIME_MODE_RANK[ceiling];

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

const ProviderPermissionSpecialPath = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["root", "minimal", "tmpdir", "slash_tmp"]) }),
  Schema.Struct({
    kind: Schema.Literal("project_roots"),
    subpath: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    path: Schema.String,
    subpath: Schema.optionalKey(Schema.String),
  }),
]);

const ProviderPermissionFileSystemEntry = Schema.Struct({
  access: Schema.Literals(["read", "write", "deny"]),
  path: Schema.Union([
    Schema.Struct({ type: Schema.Literal("path"), path: Schema.String }),
    Schema.Struct({ type: Schema.Literal("glob_pattern"), pattern: Schema.String }),
    Schema.Struct({ type: Schema.Literal("special"), value: ProviderPermissionSpecialPath }),
  ]),
});

/**
 * The grant an approval hands the provider, kept as the provider sent it so a
 * reconnecting client sees the same request the decision answers. `read` and
 * `write` are Codex's legacy path lists, which it sends next to `entries`.
 */
export const ProviderApprovalPermissions = Schema.Struct({
  network: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
  fileSystem: Schema.optionalKey(
    Schema.Struct({
      entries: Schema.optionalKey(Schema.Array(ProviderPermissionFileSystemEntry)),
      globScanMaxDepth: Schema.optionalKey(Schema.Number),
      read: Schema.optionalKey(Schema.Array(Schema.String)),
      write: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
export type ProviderApprovalPermissions = typeof ProviderApprovalPermissions.Type;

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
