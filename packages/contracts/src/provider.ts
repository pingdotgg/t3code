import { z } from "zod";

export const providerKindSchema = z.enum(["codex", "claudeCode"]);

export const providerApprovalPolicySchema = z.enum([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);

export const providerSandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

export const providerRequestKindSchema = z.enum(["command", "file-change"]);

export const providerApprovalDecisionSchema = z.enum([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);

export const providerSessionStatusSchema = z.enum([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const providerSessionSchema = z.object({
  sessionId: z.string().min(1),
  provider: providerKindSchema,
  status: providerSessionStatusSchema,
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  activeTurnId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().min(1).optional(),
});

export const providerSessionStartInputSchema = z.object({
  provider: providerKindSchema.default("codex"),
  cwd: z.string().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  approvalPolicy: providerApprovalPolicySchema.default("never"),
  sandboxMode: providerSandboxModeSchema.default("workspace-write"),
});

export const providerSendTurnInputSchema = z.object({
  sessionId: z.string().min(1),
  input: z.string().trim().min(1).max(120_000),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
});

export const providerTurnStartResultSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});

export const providerInterruptTurnInputSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1).optional(),
});

export const providerStopSessionInputSchema = z.object({
  sessionId: z.string().min(1),
});

export const providerRespondToRequestInputSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  decision: providerApprovalDecisionSchema,
});

export const providerEventKindSchema = z.enum([
  "session",
  "notification",
  "request",
  "error",
]);

export const providerEventSchema = z.object({
  id: z.string().min(1),
  kind: providerEventKindSchema,
  provider: providerKindSchema,
  sessionId: z.string().min(1),
  createdAt: z.string().datetime(),
  method: z.string().min(1),
  message: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  requestKind: providerRequestKindSchema.optional(),
  textDelta: z.string().optional(),
  payload: z.unknown().optional(),
});

export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ProviderApprovalPolicy = z.infer<typeof providerApprovalPolicySchema>;
export type ProviderSandboxMode = z.infer<typeof providerSandboxModeSchema>;
export type ProviderRequestKind = z.infer<typeof providerRequestKindSchema>;
export type ProviderApprovalDecision = z.infer<
  typeof providerApprovalDecisionSchema
>;
export type ProviderSessionStatus = z.infer<typeof providerSessionStatusSchema>;
export type ProviderSession = z.infer<typeof providerSessionSchema>;
export type ProviderSessionStartInput = z.input<typeof providerSessionStartInputSchema>;
export type ProviderSendTurnInput = z.input<typeof providerSendTurnInputSchema>;
export type ProviderTurnStartResult = z.infer<
  typeof providerTurnStartResultSchema
>;
export type ProviderInterruptTurnInput = z.input<
  typeof providerInterruptTurnInputSchema
>;
export type ProviderStopSessionInput = z.input<
  typeof providerStopSessionInputSchema
>;
export type ProviderRespondToRequestInput = z.input<
  typeof providerRespondToRequestInputSchema
>;
export type ProviderEventKind = z.infer<typeof providerEventKindSchema>;
export type ProviderEvent = z.infer<typeof providerEventSchema>;
