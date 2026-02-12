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
  resumeThreadId: z.string().trim().min(1).optional(),
  approvalPolicy: providerApprovalPolicySchema.default("never"),
  sandboxMode: providerSandboxModeSchema.default("workspace-write"),
});

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_IMAGES = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;

export const providerSendTurnImageInputSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    mimeType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^image\//i, "mimeType must be an image/* MIME type"),
    sizeBytes: z.number().int().min(1).max(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
    dataUrl: z.string().trim().min(1).max(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  })
  .superRefine((value, ctx) => {
    if (!value.dataUrl.startsWith("data:image/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Image dataUrl must start with data:image/",
        path: ["dataUrl"],
      });
    }
  });

export const providerSendTurnInputSchema = z.object({
  sessionId: z.string().min(1),
  input: z.string().trim().min(1).max(PROVIDER_SEND_TURN_MAX_INPUT_CHARS).optional(),
  images: z.array(providerSendTurnImageInputSchema).max(PROVIDER_SEND_TURN_MAX_IMAGES).default([]),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!value.input && value.images.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either input text or at least one image is required",
      path: ["input"],
    });
  }
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

export const providerEventKindSchema = z.enum(["session", "notification", "request", "error"]);

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
export type ProviderApprovalDecision = z.infer<typeof providerApprovalDecisionSchema>;
export type ProviderSessionStatus = z.infer<typeof providerSessionStatusSchema>;
export type ProviderSession = z.infer<typeof providerSessionSchema>;
export type ProviderSessionStartInput = z.input<typeof providerSessionStartInputSchema>;
export type ProviderSendTurnImage = z.infer<typeof providerSendTurnImageInputSchema>;
export type ProviderSendTurnImageInput = z.input<typeof providerSendTurnImageInputSchema>;
export type ProviderSendTurnInput = z.input<typeof providerSendTurnInputSchema>;
export type ProviderTurnStartResult = z.infer<typeof providerTurnStartResultSchema>;
export type ProviderInterruptTurnInput = z.input<typeof providerInterruptTurnInputSchema>;
export type ProviderStopSessionInput = z.input<typeof providerStopSessionInputSchema>;
export type ProviderRespondToRequestInput = z.input<typeof providerRespondToRequestInputSchema>;
export type ProviderEventKind = z.infer<typeof providerEventKindSchema>;
export type ProviderEvent = z.infer<typeof providerEventSchema>;
