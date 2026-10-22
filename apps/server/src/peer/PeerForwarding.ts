import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLinksResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import { assertNotLinked } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readCaller, unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/**
 * A peer's `/mcp` holds a wait open for its whole timeout without sending
 * anything, and T3 Connect's edge drops a request idle for about 100 s, so a
 * forwarded wait goes out in pieces no longer than this.
 */
export const FORWARDED_WAIT_CHUNK_MS = 50_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * Runs T3 MCP tools in a linked environment for an agent here. The tool's own
 * declaration checks the agent here first; the linked environment then holds
 * the call to the link's access, narrowed to the agent's modes, which every
 * forwarded call carries.
 */
export class PeerForwarding extends Context.Service<
  PeerForwarding,
  {
    /**
     * Runs `tool` in the linked environment `environmentId` with `params`. A
     * `t3_thread_wait` goes in pieces short enough to survive any route.
     */
    readonly call: <T extends Tool.Any>(
      scope: Scope,
      tool: T,
      environmentId: EnvironmentId,
      params: Tool.Parameters<T>,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    /** `t3_thread_read` there. */
    readonly readThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** `t3_thread_interrupt` there. */
    readonly interruptThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
    /** `t3_thread_wait` there, in pieces short enough to survive any route. */
    readonly waitForThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
    /** The environments this one links to, as an agent sees them. */
    readonly links: (
      scope: Scope,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinksResult, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerForwarding") {}

/** The linked environment a call names, or nothing when it names this one. */
export const remoteTarget = (scope: Scope, environmentId: EnvironmentId | undefined) =>
  environmentId === scope.environmentId ? undefined : environmentId;

const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;

  /**
   * The caller's own limits here, which travel with every call it forwards.
   * The peer sees only the link's credential, so a credential that may not
   * control threads here is refused here. Work a link started here never uses
   * this environment's own links: the peer would see this environment's
   * session, not the link the work came from, so its fence could not hold.
   */
  const callerLimits = (scope: Scope) =>
    readCaller().pipe(
      Effect.tap((caller) => assertNotLinked(caller, "use this environment's links")),
      Effect.map((caller) => caller.limits),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /**
   * Every caller here reaches the peer as the one link session, so a retry
   * key is scoped to its caller before it leaves: two agents here reusing a
   * key never collide there, and one agent retrying gets its first result.
   */
  const scopedRequestId = (namespace: string, clientRequestId: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(`${namespace}\n${clientRequestId}`)).pipe(
      Effect.map((digest) => `fwd:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  /** Tool and contract schemas are plain data: they encode and decode without services. */
  const forward = Effect.fn("PeerForwarding.forward")(function* <A>(
    scope: Scope,
    toolName: string,
    parameters: Schema.Top,
    success: Schema.Top,
    environmentId: EnvironmentId,
    params: unknown,
  ) {
    const limits = yield* callerLimits(scope);
    const encoded = (yield* Schema.encodeUnknownEffect(parameters as Schema.Encoder<unknown>)(
      params,
    ).pipe(Effect.mapError(unavailable))) as Record<string, unknown>;
    const { environmentId: _target, ...args } = encoded;
    // A pending upload lives here, so it cannot go with the call.
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A launch in a linked environment cannot carry attachments yet.",
      });
    }
    if (typeof args.clientRequestId === "string") {
      args.clientRequestId = yield* scopedRequestId(scope.requestNamespace, args.clientRequestId);
    }
    return yield* peers.call({
      environmentId,
      tool: toolName,
      arguments: args,
      limits,
      success: success as Schema.Decoder<A>,
    });
  });

  const readThread: PeerForwarding["Service"]["readThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadReadResult>(
      scope,
      "t3_thread_read",
      OrchestratorMcpThreadReadInput,
      OrchestratorMcpThreadReadResult,
      environmentId,
      input,
    );

  const interruptThread: PeerForwarding["Service"]["interruptThread"] = (
    scope,
    environmentId,
    input,
  ) =>
    forward<OrchestratorMcpThreadInterruptResult>(
      scope,
      "t3_thread_interrupt",
      OrchestratorMcpThreadInterruptInput,
      OrchestratorMcpThreadInterruptResult,
      environmentId,
      input,
    );

  const waitForThread: PeerForwarding["Service"]["waitForThread"] = Effect.fn(
    "PeerForwarding.waitForThread",
  )(function* (scope, environmentId, input) {
    let remaining = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    let runId = input.runId;
    while (true) {
      const chunk = Math.min(remaining, FORWARDED_WAIT_CHUNK_MS);
      const result = yield* forward<OrchestratorMcpThreadWaitResult>(
        scope,
        "t3_thread_wait",
        OrchestratorMcpThreadWaitInput,
        OrchestratorMcpThreadWaitResult,
        environmentId,
        {
          threadId: input.threadId,
          ...(runId === undefined ? {} : { runId }),
          timeoutMs: chunk,
          ...(input.untilDelegatedWorkSettled === undefined
            ? {}
            : { untilDelegatedWorkSettled: input.untilDelegatedWorkSettled }),
        },
      );
      remaining -= chunk;
      if (!result.timedOut || remaining <= 0) return result;
      // Later pieces wait for the run the first one picked, not a newer one.
      runId = result.runId ?? undefined;
    }
  });

  const call: PeerForwarding["Service"]["call"] = (scope, tool, environmentId, params) =>
    tool.name === "t3_thread_wait"
      ? (waitForThread(
          scope,
          environmentId,
          params as OrchestratorMcpThreadWaitInput,
        ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>)
      : forward(scope, tool.name, tool.parametersSchema, tool.successSchema, environmentId, params);

  /**
   * The next step for an agent whose machine is not linked: without it, an
   * empty list reads as a dead end and agents go looking elsewhere.
   */
  const NOT_LISTED =
    "A machine the user means that is not listed here is not linked yet: call t3_environment_link with a hint from their words (or the environmentId of a machine they mentioned), and the user picks it and its access in a card.";

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      yield* callerLimits(scope);
      const listed = yield* links.list.pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
      return {
        environmentId: scope.environmentId,
        links: listed.map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          status: link.status,
          access: link.access,
          expiresAt: DateTime.formatIso(link.expiresAt),
          lastError: link.lastError,
        })),
        notListed: NOT_LISTED,
      };
    },
  );

  return PeerForwarding.of({
    call,
    readThread,
    interruptThread,
    waitForThread,
    links: listLinks,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
