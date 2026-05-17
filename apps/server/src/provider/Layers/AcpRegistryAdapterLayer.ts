import {
  ApprovalRequestId,
  EventId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProviderModel,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { SpawnTarget } from "../../acpRegistry/installer.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { buildModelsFromSessionSetup } from "../acp/configOptionModels.ts";
import * as AcpConnection from "../acp/AcpConnection.ts";
import { makeAcpMultiSession, type AcpMultiSessionShape } from "../acp/AcpMultiSession.ts";
import type { AcpRegistryAdapterShape } from "../Services/AcpRegistryAdapter.ts";
import { forkAcpEventForwarder } from "./acpRegistryAdapter/eventForwarding.ts";
import { buildFileHandlers } from "./acpRegistryAdapter/fileHandlers.ts";
import { resolveSelectedAcpModel } from "./acpRegistryAdapter/helpers.ts";
import { buildPermissionHandler } from "./acpRegistryAdapter/permissionHandlers.ts";
import type {
  AcpRegistryHandlerContext,
  AcpRegistrySessionContext,
  PendingApproval,
} from "./acpRegistryAdapter/types.ts";

export interface AcpRegistryAdapterOptions {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly spawnTarget: SpawnTarget | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onModelsDiscovered?: (models: ReadonlyArray<ServerProviderModel>) => Effect.Effect<void>;
  /** Fired when a discovery attempt fails (timeout or session/new error). */
  readonly onDiscoveryFailed?: (reason: string) => Effect.Effect<void>;
}

export type AcpRegistryAdapterEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ServerConfig;

export const makeAcpRegistryAdapter = Effect.fn("makeAcpRegistryAdapter")(function* (
  options: AcpRegistryAdapterOptions,
) {
  const provider = options.driverKind;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const sessions = new Map<ThreadId, AcpRegistrySessionContext>();
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(Effect.orDie);
  const makeEventStamp = () =>
    Effect.all({
      eventId: Effect.map(randomUUIDv4, EventId.make),
      createdAt: nowIso,
    });
  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
  const handlerContext: AcpRegistryHandlerContext = {
    provider,
    makeEventStamp,
    makeApprovalRequestId: () => Effect.map(randomUUIDv4, ApprovalRequestId.make),
    offerRuntimeEvent,
  };

  const getThreadSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const applySelectedAcpModel = (
    acp: AcpMultiSessionShape,
    modelSelection:
      | { readonly instanceId?: ProviderInstanceId; readonly model?: string }
      | undefined,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      const selectedModel = resolveSelectedAcpModel(
        yield* acp.getConfigOptions,
        modelSelection,
        options,
      );
      if (!selectedModel) {
        return;
      }
      yield* acp.setModel(selectedModel);
    }).pipe(
      Effect.mapError((error) =>
        mapAcpToAdapterError(provider, threadId, "session/set_config_option", error),
      ),
    );

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<AcpRegistrySessionContext, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
    }
    return Effect.succeed(ctx);
  };

  const settlePendingApprovals = (pending: ReadonlyMap<ApprovalRequestId, PendingApproval>) =>
    Effect.forEach(
      Array.from(pending.values()),
      (entry) => Deferred.succeed(entry.decision, "decline").pipe(Effect.ignore),
      { discard: true },
    );

  const stopSessionInternal = (ctx: AcpRegistrySessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      yield* settlePendingApprovals(ctx.pendingApprovals);
      if (ctx.notificationFiber) {
        yield* Fiber.interrupt(ctx.notificationFiber);
      }
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      sessions.delete(ctx.threadId);
      yield* offerRuntimeEvent({
        type: "session.exited",
        ...(yield* makeEventStamp()),
        provider,
        threadId: ctx.threadId,
        payload: { exitKind: "graceful" },
      });
    });

  // Connection pool: one child process per (cwd, spawn signature). Sessions multiplex onto these
  // connections, matching Zed's pattern (zed/crates/agent_servers/src/acp.rs).
  interface PooledConnection {
    readonly connection: AcpConnection.AcpConnection["Service"];
    readonly scope: Scope.Closeable;
    refCount: number;
  }
  const connections = new Map<string, PooledConnection>();

  const connectionKey = (spawnTarget: SpawnTarget, cwd: string): string => {
    const env: NodeJS.ProcessEnv = {
      ...options.environment,
      ...spawnTarget.env,
    };
    const envFingerprint = Object.entries(env)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    return [spawnTarget.command, spawnTarget.args.join("\0"), cwd, envFingerprint].join("");
  };

  const acquireConnection = (spawnTarget: SpawnTarget, cwd: string) =>
    Effect.gen(function* () {
      const key = connectionKey(spawnTarget, cwd);
      const existing = connections.get(key);
      if (existing) {
        existing.refCount += 1;
        return existing;
      }
      const connectionScope = yield* Scope.make("sequential");
      const env: NodeJS.ProcessEnv = {
        ...options.environment,
        ...spawnTarget.env,
      };
      const connectionContext = yield* Layer.build(
        AcpConnection.layer({
          spawn: {
            command: spawnTarget.command,
            args: [...spawnTarget.args],
            cwd,
            env,
          },
          clientInfo: { name: "t3-code", version: "0.0.0" },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
      ).pipe(Effect.provideService(Scope.Scope, connectionScope));
      const connection = yield* Effect.service(AcpConnection.AcpConnection).pipe(
        Effect.provide(connectionContext),
      );
      const pooled: PooledConnection = {
        connection,
        scope: connectionScope,
        refCount: 1,
      };
      connections.set(key, pooled);
      return pooled;
    });

  const releaseConnection = (spawnTarget: SpawnTarget, cwd: string) =>
    Effect.gen(function* () {
      const key = connectionKey(spawnTarget, cwd);
      const pooled = connections.get(key);
      if (!pooled) return;
      pooled.refCount -= 1;
      if (pooled.refCount <= 0) {
        connections.delete(key);
        yield* Effect.ignore(Scope.close(pooled.scope, Exit.void));
      }
    });

  const startSession: AcpRegistryAdapterShape["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== provider) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: `Expected provider '${provider}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        if (!options.spawnTarget) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: "Agent is not installed. Install it from Settings → ACP Registry.",
          });
        }
        const spawnTarget = options.spawnTarget;
        const cwd = input.cwd.trim();

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        let ctx!: AcpRegistrySessionContext;

        const pooled = yield* acquireConnection(spawnTarget, cwd).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider,
                threadId: input.threadId,
                detail: "Failed to acquire the ACP connection.",
                cause,
              }),
          ),
        );
        let connectionReleased = false;
        const releasePooledConnection = Effect.suspend(() => {
          if (connectionReleased) return Effect.void;
          connectionReleased = true;
          return releaseConnection(spawnTarget, cwd);
        });

        // Per-session scope: cleanup tied to this thread only; never closes the pooled connection
        // unless the refcount drops to zero (handled by releasePooledConnection below).
        const sessionScope = yield* Scope.make("sequential");
        // Bind connection release to the session scope: when the session closes, ref-- on the pool.
        yield* Scope.addFinalizer(sessionScope, releasePooledConnection);

        let sessionScopeTransferred = false;
        // If startSession fails BEFORE we transfer ownership, drop the session scope
        // (which triggers release of the connection).
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const fileHandlers = buildFileHandlers({ fileSystem, cwd });
        const permissionHandler = buildPermissionHandler({
          threadId: input.threadId,
          pendingApprovals,
          getActiveTurnId: () => ctx?.activeTurnId,
          context: handlerContext,
        });

        const acp = yield* makeAcpMultiSession({
          connection: pooled.connection,
          cwd,
          handlers: {
            onRequestPermission: permissionHandler,
            onReadTextFile: fileHandlers.onReadTextFile,
            onWriteTextFile: fileHandlers.onWriteTextFile,
          },
        }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(provider, input.threadId, "session/start", error),
          ),
        );

        // Release session handlers from connection when the session scope closes — NOT when
        // startSession returns. The session lives past startSession (handlers must remain wired
        // for incoming session/update notifications until the chat is closed).
        const sessionIdForCleanup = acp.sessionId;
        yield* Scope.addFinalizer(
          sessionScope,
          pooled.connection.releaseSession(sessionIdForCleanup),
        );

        yield* applySelectedAcpModel(acp, input.modelSelection, input.threadId);

        if (options.onModelsDiscovered) {
          const onModelsDiscovered = options.onModelsDiscovered;
          const models = buildModelsFromSessionSetup(acp.setupResult.sessionSetupResult);
          yield* Effect.logInfo("ACP registry session models discovered", {
            provider,
            instanceId: options.instanceId,
            threadId: input.threadId,
            modelCount: models.length,
            sessionModels: acp.setupResult.sessionSetupResult.models ?? null,
            configOptionCategories:
              acp.setupResult.sessionSetupResult.configOptions?.map((opt) => ({
                id: opt.id,
                category: opt.category,
                type: opt.type,
              })) ?? null,
          });
          if (models.length > 0) {
            yield* onModelsDiscovered(models).pipe(
              Effect.ignoreCause({ log: true }),
              Effect.forkDetach,
              Effect.asVoid,
            );
          }
        }

        const now = yield* nowIso;
        const session: ProviderSession = {
          provider,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
        };

        ctx = {
          threadId: input.threadId,
          session,
          scope: sessionScope,
          acp,
          notificationFiber: undefined,
          pendingApprovals,
          turns: [],
          activeTurnId: undefined,
          stopped: false,
        };

        const notificationFiber = yield* forkAcpEventForwarder({
          acp,
          getSessionContext: () => ctx,
          context: handlerContext,
        });

        ctx.notificationFiber = notificationFiber;
        sessions.set(input.threadId, ctx);
        sessionScopeTransferred = true;

        yield* offerRuntimeEvent({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider,
          threadId: input.threadId,
          payload: { resume: undefined },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider,
          threadId: input.threadId,
          payload: { state: "ready", reason: "ACP session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider,
          threadId: input.threadId,
          payload: { providerThreadId: acp.sessionId },
        });

        return session;
      }).pipe(Effect.scoped),
    );

  const sendTurn: AcpRegistryAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      const turnId = TurnId.make(yield* randomUUIDv4);
      ctx.activeTurnId = turnId;
      ctx.session = {
        ...ctx.session,
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
      };

      yield* offerRuntimeEvent({
        type: "turn.started",
        ...(yield* makeEventStamp()),
        provider,
        threadId: input.threadId,
        turnId,
        payload: {},
      });

      const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
      if (input.input?.trim()) {
        promptParts.push({ type: "text", text: input.input.trim() });
      }
      for (const attachment of input.attachments ?? []) {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "session/prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider,
                method: "session/prompt",
                detail: `Failed to read attachment '${attachment.id}'.`,
                cause,
              }),
          ),
        );
        promptParts.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }

      if (promptParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }

      yield* applySelectedAcpModel(ctx.acp, input.modelSelection, input.threadId);

      const result = yield* ctx.acp
        .prompt({ prompt: promptParts })
        .pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(provider, input.threadId, "session/prompt", error),
          ),
        );

      ctx.turns.push({
        id: turnId,
        items: [{ prompt: promptParts, result }],
      });
      ctx.session = {
        ...ctx.session,
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
      };

      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...(yield* makeEventStamp()),
        provider,
        threadId: input.threadId,
        turnId,
        payload: {
          state: result.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: result.stopReason ?? null,
        },
      });

      return { threadId: input.threadId, turnId };
    });

  const interruptTurn: AcpRegistryAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      yield* settlePendingApprovals(ctx.pendingApprovals);
      yield* Effect.ignore(ctx.acp.cancel);
    });

  const respondToRequest: AcpRegistryAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider,
          method: "session/request_permission",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.decision, decision);
    });

  const respondToUserInput: AcpRegistryAdapterShape["respondToUserInput"] = (
    _threadId,
    requestId,
  ) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider,
        method: "session/request_user_input",
        detail: `Structured user input is not supported by ACP registry agents (request ${requestId}).`,
      }),
    );

  const readThread: AcpRegistryAdapterShape["readThread"] = (threadId) =>
    Effect.map(requireSession(threadId), (ctx) => ({
      threadId,
      turns: ctx.turns,
    }));

  const rollbackThread: AcpRegistryAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
      return { threadId, turns: ctx.turns };
    });

  const stopSession: AcpRegistryAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));

  const listSessions: AcpRegistryAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

  const hasSession: AcpRegistryAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      return ctx !== undefined && !ctx.stopped;
    });

  const stopAll: AcpRegistryAdapterShape["stopAll"] = () =>
    Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions.values(), stopSessionInternal, {
      discard: true,
    }).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
  );

  /**
   * Probe the agent without involving the UI: spawn (or reuse) a connection, do session/new,
   * extract models, fire onModelsDiscovered, release. Used at boot to populate the model list
   * before the user opens a chat. Throws never — errors are logged and swallowed.
   */
  const discoverModels = (cwd: string): Effect.Effect<void, never, AcpRegistryAdapterEnv> =>
    Effect.gen(function* () {
      yield* Effect.logInfo("ACP registry discoverModels: starting", {
        provider,
        instanceId: options.instanceId,
        cwd,
        hasSpawnTarget: options.spawnTarget !== undefined,
      });
      if (!options.spawnTarget) return;
      const spawnTarget = options.spawnTarget;
      const pooled = yield* acquireConnection(spawnTarget, cwd).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("ACP registry discoverModels: acquire failed", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (!pooled) return;

      const sessionScope = yield* Scope.make("sequential");
      let sessionClosed = false;
      let connectionReleased = false;
      // Close the *session* immediately (we don't need to keep handlers wired); keep the
      // *connection* warm for a few minutes so the user's first chat in this cwd reuses
      // the already-spawned process instead of paying cold-start again.
      const WARM_KEEP_ALIVE = "5 minutes";
      const closeSessionOnly = Effect.suspend(() => {
        if (sessionClosed) return Effect.void;
        sessionClosed = true;
        return Scope.close(sessionScope, Exit.void);
      });
      const releaseConnectionLater = Effect.suspend(() => {
        if (connectionReleased) return Effect.void;
        connectionReleased = true;
        return releaseConnection(spawnTarget, cwd);
      }).pipe(Effect.delay(WARM_KEEP_ALIVE));

      // Hard cap discovery: some agents (Junie/JVM cold-start, or auth-required ones that wait
      // silently) can hang forever on session/new. Match the old 30s budget, but bias up to 90s
      // to give Junie's JVM realistic headroom.
      const DISCOVERY_TIMEOUT = "90 seconds";
      const result = yield* Effect.exit(
        makeAcpMultiSession({
          connection: pooled.connection,
          cwd,
          handlers: {},
        }).pipe(Effect.timeout(DISCOVERY_TIMEOUT)),
      );
      if (Exit.isSuccess(result)) {
        const acp = result.value;
        yield* Scope.addFinalizer(sessionScope, pooled.connection.releaseSession(acp.sessionId));

        const models = buildModelsFromSessionSetup(acp.setupResult.sessionSetupResult);
        yield* Effect.logInfo("ACP registry boot-time model discovery", {
          provider,
          instanceId: options.instanceId,
          modelCount: models.length,
        });
        if (models.length > 0 && options.onModelsDiscovered) {
          yield* options.onModelsDiscovered(models).pipe(Effect.ignoreCause({ log: true }));
        }
      } else {
        const prettyCause = Cause.pretty(result.cause);
        yield* Effect.logWarning("ACP registry discoverModels: session/new failed", {
          provider,
          instanceId: options.instanceId,
          cause: prettyCause,
        });
        if (options.onDiscoveryFailed) {
          yield* options
            .onDiscoveryFailed(prettyCause.split("\n", 1)[0] ?? "unknown")
            .pipe(Effect.ignoreCause({ log: true }));
        }
      }

      // Close session NOW (releases handlers, decrements nothing); keep connection warm.
      // The delayed release runs in a detached fiber so the discovery effect can return.
      yield* closeSessionOnly;
      yield* releaseConnectionLater.pipe(Effect.forkDetach, Effect.asVoid);
    }).pipe(Effect.scoped, Effect.ignoreCause({ log: true }));

  return {
    provider,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    discoverModels,
  } satisfies AcpRegistryAdapterShape & {
    readonly discoverModels: (cwd: string) => Effect.Effect<void, never, AcpRegistryAdapterEnv>;
  };
});
