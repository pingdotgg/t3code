import type { V2TurnStartParams__AskForApproval } from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import { EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX } from "@t3tools/provider-core/server/mcpSession";

export function withHostElicitation(policy: V2TurnStartParams__AskForApproval, needed: boolean) {
  if (!needed) return policy;
  if (policy === "never")
    return {
      granular: {
        mcp_elicitations: true,
        rules: false,
        sandbox_approval: false,
        request_permissions: false,
        skill_approval: false,
      },
    };
  return typeof policy === "object"
    ? { granular: { ...policy.granular, mcp_elicitations: true } }
    : policy;
}
export function permitsOrdinaryElicitation(policy: unknown, fullAccess: boolean) {
  if (policy === "never" || (policy === undefined && fullAccess)) return false;
  return !(
    typeof policy === "object" &&
    policy !== null &&
    "granular" in policy &&
    typeof policy.granular === "object" &&
    policy.granular !== null &&
    "mcp_elicitations" in policy.granular &&
    policy.granular.mcp_elicitations === false
  );
}

export const hostVerificationApplies = (
  attestationEnabled: boolean | undefined,
  policy: { readonly runtimeMode: string; readonly interactionMode: string },
) =>
  attestationEnabled === true &&
  policy.runtimeMode === "full-access" &&
  policy.interactionMode === "default";

const isFormMode = (mode: string) =>
  mode === "form" || mode === "openai/form" || mode === "openaiForm";

const isEmptyObjectSchema = (schema: unknown) =>
  typeof schema === "object" &&
  schema !== null &&
  "type" in schema &&
  schema.type === "object" &&
  "properties" in schema &&
  typeof schema.properties === "object" &&
  schema.properties !== null &&
  Object.keys(schema.properties).length === 0;

const isToolApproval = (meta: unknown) =>
  typeof meta === "object" &&
  meta !== null &&
  "codex_approval_kind" in meta &&
  meta.codex_approval_kind === "mcp_tool_call";

export interface HostTurn {
  readonly nativeThreadId: string;
  readonly providerSessionId: string;
  readonly nativeChild: boolean;
  readonly enabled: boolean;
  readonly approvalPolicy: unknown;
  readonly fullAccess: boolean;
}

export const handleHostElicitation = Effect.fn("Codex.handleHostElicitation")(function* (
  payload: {
    readonly serverName: string;
    readonly mode: string;
    readonly message: string;
    readonly turnId?: string | null;
    readonly threadId: string;
    readonly _meta?: unknown;
    readonly requestedSchema?: unknown;
  },
  lookup: (turnId: string) => Effect.Effect<HostTurn | undefined>,
  attest: (challenge: string, session: string, child: boolean) => Effect.Effect<boolean>,
) {
  const host = payload.message.startsWith(EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX);
  const context = payload.turnId == null ? undefined : yield* lookup(payload.turnId);
  if (host) {
    if (
      payload.serverName !== "t3-code" ||
      !isFormMode(payload.mode) ||
      context === undefined ||
      !context.enabled ||
      context.nativeThreadId !== payload.threadId
    )
      return { action: "decline" as const };
    return (yield* attest(
      payload.message.slice(EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX.length),
      context.providerSessionId,
      context.nativeChild,
    ))
      ? { action: "accept" as const, content: { confirmed: true } }
      : { action: "decline" as const };
  }
  // `never` runs these without asking, but Codex stops skipping them once host elicitation is on.
  if (
    context?.enabled &&
    context.fullAccess &&
    context.nativeThreadId === payload.threadId &&
    (context.approvalPolicy === "never" || context.approvalPolicy === undefined) &&
    isFormMode(payload.mode) &&
    isEmptyObjectSchema(payload.requestedSchema) &&
    isToolApproval(payload._meta)
  )
    return { action: "accept" as const, content: {} };
  if (context?.enabled && !permitsOrdinaryElicitation(context.approvalPolicy, context.fullAccess))
    return { action: "decline" as const };
  return undefined;
});
