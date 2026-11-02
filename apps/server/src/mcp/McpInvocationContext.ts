import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** A delegated child task; its parent owns the work it hands back. */
  readonly subagent?: boolean;
}

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  /**
   * Another T3 Code environment's peer link. What it starts here carries its
   * session as `linkOrigin`, and it changes only that work (`linkOrigin.ts`).
   */
  readonly linked?: boolean | undefined;
  /**
   * Narrower modes the client asked for on this request (`T3-Mode-Limit`):
   * another environment passing on the limits of the agent it calls for.
   */
  readonly narrowedTo?: ClientModes | undefined;
  /** The origin an outside client reached; its thread links open the web app there. */
  readonly webOrigin?: string | undefined;
}

/**
 * `T3-Mode-Limit: <runtimeMode>/<interactionMode>` lets an OAuth client cap
 * a request below what it was approved with: another environment passes on
 * the limits of the agent it calls for. It can only narrow (see
 * `clientModeCeiling`), so a client gains nothing by sending a broad one.
 */
export const MODE_LIMIT_HEADER = "t3-mode-limit";

export interface ClientModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

/**
 * The modes a client caller's writes are capped at: what it was approved
 * with, narrowed by what it asked for on this request. A read-only client
 * never reaches a write (`McpToolAccess` refuses it first), so it maps to the
 * lowest runtime mode rather than to nothing.
 */
export const clientModeCeiling = (client: McpClientCaller | undefined): ClientModes => {
  const approved: ClientModes = {
    runtimeMode:
      client === undefined || client.access === "read-only" ? "approval-required" : client.access,
    interactionMode: "default",
  };
  const asked = client?.narrowedTo;
  if (asked === undefined) return approved;
  return {
    runtimeMode:
      runtimeModeRank[asked.runtimeMode] < runtimeModeRank[approved.runtimeMode]
        ? asked.runtimeMode
        : approved.runtimeMode,
    interactionMode:
      interactionModeRank[asked.interactionMode] < interactionModeRank[approved.interactionMode]
        ? asked.interactionMode
        : approved.interactionMode,
  };
};

/**
 * A client approved above an administrator's runtime-mode ceiling acts as if it had narrowed
 * itself to the ceiling, so what it starts and schedules is not refused for a mode it never chose.
 */
export const withRuntimeModeCeiling = (
  scope: McpInvocationScope,
  ceiling: RuntimeMode | undefined,
): McpInvocationScope => {
  if (ceiling === undefined || scope.client === undefined) return scope;
  const asked = scope.client.narrowedTo;
  return {
    ...scope,
    client: {
      ...scope.client,
      narrowedTo: {
        runtimeMode:
          asked !== undefined && runtimeModeRank[asked.runtimeMode] < runtimeModeRank[ceiling]
            ? asked.runtimeMode
            : ceiling,
        interactionMode: asked?.interactionMode ?? "default",
      },
    },
  };
};

/** Thread callers default to their own thread; client callers need thread for tools that act as the caller. */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
  /** False while the Linked environments beta is off here; `/mcp` reads it per request. */
  readonly linkedEnvironments?: boolean;
}

/**
 * T3 Code renders `t3-thread://` links as thread chips. Other MCP clients cannot open them, so
 * they get a web URL on the origin they reached instead.
 */
export const threadLinkFor = (
  scope: Pick<McpInvocationScope, "environmentId" | "client">,
  threadId: ThreadId,
): string => {
  const origin = scope.client?.webOrigin;
  return origin === undefined
    ? formatThreadLink({ environmentId: scope.environmentId, threadId })
    : `${origin}/${encodeURIComponent(scope.environmentId)}/${encodeURIComponent(threadId)}`;
};

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/**
 * `McpSchema.EnabledWhen` for tools a delegated child must not see or call.
 * EnabledWhen only receives the MCP client profile, so read the T3 caller from the request fiber.
 */
export const hiddenFromSubagents = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.thread?.subagent !== true;
};

/** `McpSchema.EnabledWhen` for tools that only serve links, hidden while the beta is off. */
export const hiddenWhileLinksOff = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.linkedEnvironments !== false;
};

export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

export const requireThreadMcpCapability = <const C extends "preview" | "device">(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities.has(capability) && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.`,
  });

export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
