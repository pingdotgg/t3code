import {
  AuthSessionId,
  AuthStandardClientScopes,
  type EnvironmentId,
  EnvironmentId as EnvironmentIdSchema,
  ThreadId,
  ThreadSettleAfterTurnInput,
  ThreadTaskError,
  ThreadTaskBoardInput,
  ThreadTaskAssignInput,
  ThreadTaskReadInput,
  ThreadTaskUpdateInput,
  ThreadTaskWatchInput,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionCatalogEntry,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  createGatewayRuntimeEventSourceFromContext,
  createGatewayRuntimePortFromContext,
  type GatewayRuntimeEventSource,
  type GatewayRuntimePort,
} from "@t3tools/client-runtime/gateway";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcTest } from "effect/rpc";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadTaskService from "../../threadTask/ThreadTaskService.ts";
import { makeInProcessWsRpcLayer } from "../../ws.ts";

/**
 * The T3 Agents gateway tools for this environment, run against the server's own
 * WebSocket RPC API through an in-memory client. Tools behave exactly as they do for a
 * remote client, because they use the same runtime port and the same RPC handlers.
 */
export class LocalGatewayPort extends Context.Service<
  LocalGatewayPort,
  {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly port: GatewayRuntimePort;
    /** This environment's thread events, as an app's gateway runtime forwards them. */
    readonly events: GatewayRuntimeEventSource;
  }
>()("t3/mcp/agents/LocalGatewayPort") {}

// Agents act like a normally paired client: orchestration, terminals and reviews, but no
// access or relay administration.
const session: AuthenticatedSession = {
  sessionId: AuthSessionId.make("t3-agents-mcp"),
  subject: "t3-agents-mcp",
  method: "bearer-access-token",
  scopes: AuthStandardClientScopes,
};

/**
 * Thread task calls for this environment, run on the task service directly so a chat
 * keeps its own identity. `caller` comes only from the server's authenticated MCP
 * credential; the in-process RPC session is a user and cannot name a chat.
 */
const makeThreadTask = (
  environmentId: EnvironmentId,
  tasks: ThreadTaskService.ThreadTaskService["Service"],
  fallback: GatewayRuntimePort["threadTask"],
): NonNullable<GatewayRuntimePort["threadTask"]> => {
  const decodeAssign = Schema.decodeUnknownEffect(ThreadTaskAssignInput);
  const decodeRead = Schema.decodeUnknownEffect(ThreadTaskReadInput);
  const decodeUpdate = Schema.decodeUnknownEffect(ThreadTaskUpdateInput);
  const decodeWatch = Schema.decodeUnknownEffect(ThreadTaskWatchInput);
  const decodeSettle = Schema.decodeUnknownEffect(ThreadSettleAfterTurnInput);
  const decodeBoard = Schema.decodeUnknownEffect(ThreadTaskBoardInput);
  return (target, request, caller) => {
    // A call without an authenticated chat (a client acting as the user) or a
    // peer call between environments goes through this environment's RPC.
    if (
      caller === undefined ||
      caller.environmentId !== environmentId ||
      request.action === "remoteAssign" ||
      request.action === "remoteDeliver" ||
      request.action === "remoteOwnerAction" ||
      request.action === "projectSnapshot"
    ) {
      if (fallback === undefined) throw new Error("Thread tasks are unavailable here.");
      return fallback(target, request);
    }
    // An agent's call always runs here as its own chat; a task on another
    // environment is reached by this server with the task's capability, never
    // by relaying the agent as the user.
    const actor: ThreadTaskService.ThreadTaskCaller = {
      kind: "thread",
      threadId: ThreadId.make(caller.threadId),
    };
    const remote = target === environmentId ? undefined : EnvironmentIdSchema.make(target);
    const localOnly = (action: string) =>
      Effect.fail(
        new ThreadTaskError({
          code: "scope_denied",
          detail: `${action} runs only on your chat's own environment; omit environmentId.`,
        }),
      );
    return Effect.runPromise(
      Effect.gen(function* () {
        switch (request.action) {
          case "assign":
            return yield* tasks.assign(actor, yield* decodeAssign(request.input), remote);
          case "read":
            return yield* tasks.read(actor, yield* decodeRead(request.input));
          case "update":
            return yield* tasks.update(actor, yield* decodeUpdate(request.input));
          case "watch":
            return remote === undefined
              ? yield* tasks.watch(actor, yield* decodeWatch(request.input))
              : yield* localOnly("t3_task_watch");
          case "board":
            return yield* tasks.board(actor, yield* decodeBoard(request.input));
          case "settleAfterTurn":
            return remote === undefined
              ? yield* tasks.settleAfterTurn(actor, yield* decodeSettle(request.input))
              : yield* localOnly("t3_settle_after_turn");
        }
      }),
    );
  };
};

export const layer = Layer.effect(
  LocalGatewayPort,
  Effect.gen(function* () {
    const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
    const environmentId = descriptor.environmentId;
    const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
      Effect.provide(makeInProcessWsRpcLayer(session)),
    );
    const rpcSession = {
      client,
      initialConfig: client[WS_METHODS.serverGetConfig]({}).pipe(Effect.orDie),
    };
    // The runtime port reads only these registry and supervisor members, and only for this
    // environment: it is always connected, through the in-memory client.
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: descriptor.label,
      httpBaseUrl: "",
      wsBaseUrl: "",
    });
    const supervisor = {
      target,
      session: yield* SubscriptionRef.make(Option.some(rpcSession)),
    } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    const entry: ConnectionCatalogEntry = { target, profile: Option.none(), enabled: true };
    const unavailable = (id: EnvironmentId) =>
      new EnvironmentRpcUnavailableError({
        environmentId: id,
        message: "This server only runs tools for its own environment.",
      });
    const registry = {
      entries: yield* SubscriptionRef.make(new Map([[environmentId, entry]])),
      state: (id: EnvironmentId) =>
        id === environmentId
          ? Effect.succeed({ ...AVAILABLE_CONNECTION_STATE, desired: true, phase: "connected" })
          : Effect.fail(unavailable(id)),
      run: <A, E>(
        id: EnvironmentId,
        effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
      ) =>
        id === environmentId
          ? effect.pipe(
              Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            )
          : Effect.fail(unavailable(id)),
      runStream: <A, E>(
        id: EnvironmentId,
        stream: Stream.Stream<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
      ) =>
        id === environmentId
          ? stream.pipe(
              Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            )
          : Stream.fail(unavailable(id)),
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
    const context = Context.make(EnvironmentRegistry.EnvironmentRegistry, registry).pipe(
      Context.add(SecureRandom.SecureRandom, yield* SecureRandom.SecureRandom),
    );
    const base = createGatewayRuntimePortFromContext(context);
    const tasks = yield* ThreadTaskService.ThreadTaskService;
    return LocalGatewayPort.of({
      environmentId,
      label: descriptor.label,
      port: { ...base, threadTask: makeThreadTask(environmentId, tasks, base.threadTask) },
      events: createGatewayRuntimeEventSourceFromContext(context),
    });
  }),
);
