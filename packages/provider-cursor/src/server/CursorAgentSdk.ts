import type {
  AgentMessage,
  AgentOptions,
  InteractionUpdate,
  Run,
  RunRecord,
  RunResult,
  SDKUserMessage,
  SendOptions,
  SteerAckOutcome,
} from "@cursor/sdk";
import {
  NonNegativeInt,
  type OrchestrationV2ProviderSession,
  ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as CursorSdk from "./CursorSdk.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";

export const CURSOR_AGENT_SDK_PROTOCOL = "cursor-agent-sdk.local" as const;
export const CURSOR_PROVIDER = ProviderDriverKind.make("cursor");

export class CursorAgentSdkRunnerError extends Schema.TaggedError<CursorAgentSdkRunnerError>()(
  "CursorAgentSdkRunnerError",
  {
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cursor Agent SDK ${this.method} failed.`;
  }
}

export function cursorSdkFailureMessage(error: CursorAgentSdkRunnerError): string {
  const reason = sdkErrorReason(error.cause);
  return reason === undefined
    ? error.message
    : `Cursor Agent SDK ${error.method} failed: ${reason}`;
}

// The SDK maps backend details to codes like PRO_USER_USAGE_LIMIT or RATE_LIMITED, without a status.
const CURSOR_USAGE_LIMIT_CODE =
  /^(?:resource_exhausted|rate_limited(?:_changeable)?|\w*_usage_limit|\w*_rate_limit(?:_exceeded)?)$/i;

export function isCursorUsageLimitError(cause: unknown): boolean {
  const error = isCursorAgentSdkRunnerError(cause) ? cause.cause : cause;
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return (
    Reflect.get(error, "name") === "RateLimitError" ||
    Reflect.get(error, "status") === 429 ||
    (typeof code === "string" && CURSOR_USAGE_LIMIT_CODE.test(code))
  );
}

const GENERIC_SDK_ERROR_CODES = new Set(["", "error", "unknown"]);

function sdkErrorReason(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const message = cause.message.trim();
  if (message.length === 0) return undefined;
  const code = Reflect.get(cause, "code");
  const status = Reflect.get(cause, "status");
  const details = [
    ...(typeof code === "string" && !GENERIC_SDK_ERROR_CODES.has(code) && !message.includes(code)
      ? [code]
      : []),
    ...(typeof status === "number" ? [`HTTP ${status}`] : []),
  ];
  return details.length === 0 ? message : `${message} (${details.join(", ")})`;
}

export const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdkRunnerError);

export interface CursorAgentSdkOpenInput {
  readonly operation: "create" | "resume";
  readonly agentId?: string;
  readonly storeCwd?: string;
  readonly options: AgentOptions;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface CursorAgentSdkSendInput<Error> {
  readonly message: string | SDKUserMessage;
  readonly options?: Omit<SendOptions, "onDelta">;
  readonly onDelta?: (update: InteractionUpdate) => Effect.Effect<void, Error>;
  /** Runs `agent.summarize()` instead, which takes no message or options. */
  readonly summarize?: boolean;
  /** Runs `agent.resume()`: Cursor's ResumeAction from the latest checkpoint, with no message. */
  readonly resume?: boolean;
  /**
   * Runs, in order, when a background shell this agent starts from now on starts and when it
   * ends, which is often long after the run.
   */
  readonly onBackgroundShell?: (event: CursorBackgroundShellEvent) => Effect.Effect<void>;
}

interface CursorBackgroundShellRef {
  /** The shell id Cursor gave the agent. */
  readonly id: string;
  readonly pid: number | undefined;
  readonly command: string;
}

export type CursorBackgroundShellEvent =
  | (CursorBackgroundShellRef & { readonly type: "started"; readonly stop: () => void })
  | (CursorBackgroundShellRef & {
      readonly type: "ended";
      /** Killed by the agent or by `stop`, rather than exiting by itself. */
      readonly stopped: boolean;
      readonly exitCode: number | undefined;
      /** The file Cursor logs the shell's output to. */
      readonly outputPath: string | undefined;
    });

export interface CursorAgentSdkRun {
  readonly runId: string;
  readonly agentId: string;
  readonly wait: Effect.Effect<RunResult, CursorAgentSdkRunnerError>;
  readonly cancel: Effect.Effect<void, CursorAgentSdkRunnerError>;
  /** Absent on test doubles that never steer. The live runner always sets it. */
  readonly steer?: (text: string) => Effect.Effect<SteerAckOutcome, CursorAgentSdkRunnerError>;
}

export interface CursorContextUsage {
  readonly usedTokens: number;
  readonly maxTokens: number;
}

// The SDK types a checkpoint as `unknown`; Cursor keeps the conversation's context fill on it.
const CursorCheckpoint = Schema.Struct({
  tokenDetails: Schema.Struct({ usedTokens: NonNegativeInt, maxTokens: NonNegativeInt }),
});
const decodeCursorCheckpoint = Schema.decodeUnknownOption(CursorCheckpoint);

export interface CursorAgentSdkSession {
  readonly agentId: string;
  readonly send: <Error>(
    input: CursorAgentSdkSendInput<Error>,
  ) => Effect.Effect<CursorAgentSdkRun, CursorAgentSdkRunnerError>;
  readonly listMessages: Effect.Effect<ReadonlyArray<AgentMessage>, CursorAgentSdkRunnerError>;
  /** Context fill at the latest checkpoint, if Cursor saved one. Absent on test doubles. */
  readonly readContextUsage?: Effect.Effect<
    CursorContextUsage | undefined,
    CursorAgentSdkRunnerError
  >;
  /**
   * Whether a run (the latest when omitted) saved a checkpoint of its own. Cursor keeps a stopped
   * run only from its first checkpoint on; before that the conversation lacks the run's request.
   */
  readonly runCheckpointed?: (runId?: string) => Effect.Effect<boolean, CursorAgentSdkRunnerError>;
  /**
   * Rewinds the conversation to just before the run after `runId`, as `cursor-agent` /rewind does.
   * The open agent keeps its old conversation in memory, so reopen it before the next send.
   */
  readonly rewindAfterRun?: (runId: string) => Effect.Effect<void, CursorAgentSdkRunnerError>;
  /** False once an out-of-process worker has terminated or started closing; absent on in-process sessions. */
  readonly isAlive?: () => boolean;
  readonly close: Effect.Effect<void, CursorAgentSdkRunnerError>;
}

export interface CursorAgentSdkTextGenerateInput {
  readonly prompt: string;
  readonly apiKey: string;
  readonly model: NonNullable<AgentOptions["model"]>;
  readonly cwd: string;
  readonly stateRoot: string;
}

export class CursorAgentSdkRunner extends Context.Service<
  CursorAgentSdkRunner,
  {
    readonly open: (
      input: CursorAgentSdkOpenInput,
    ) => Effect.Effect<CursorAgentSdkSession, CursorAgentSdkRunnerError>;
    readonly assertComplete: Effect.Effect<void, CursorAgentSdkRunnerError>;
    /** Absent on in-process test doubles; the out-of-process runner provides it. */
    readonly textGenerate?: (
      input: CursorAgentSdkTextGenerateInput,
    ) => Effect.Effect<RunResult, CursorAgentSdkRunnerError>;
  }
>()("@t3tools/provider-cursor/server/CursorAgentSdk/CursorAgentSdkRunner") {}

export interface CursorAgentSdkLoggedAgentOptions {
  readonly model?: AgentOptions["model"];
  readonly hasName?: boolean;
  readonly mode?: AgentOptions["mode"];
  readonly local?: {
    readonly hasCwd?: boolean;
    readonly autoReview?: boolean;
    readonly settingSources?: AgentOptions["local"] extends infer Local
      ? Local extends { readonly settingSources?: infer Sources }
        ? Sources
        : never
      : never;
    readonly sandboxEnabled?: boolean;
    readonly enableAgentRetries?: boolean;
    readonly hasCustomTools?: boolean;
  };
  readonly agents?: ReadonlyArray<string>;
}

export interface CursorAgentSdkLoggedSendOptions {
  readonly model?: SendOptions["model"];
  readonly mode?: SendOptions["mode"];
  readonly hasMcpServers?: boolean;
  readonly mcpServerNames?: ReadonlyArray<string>;
  readonly local?: {
    readonly force?: boolean;
    readonly hasCustomTools?: boolean;
  };
  readonly idempotencyKey?: string;
}

export type CursorAgentSdkProtocolLogEvent =
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "agent.open";
        readonly operation: CursorAgentSdkOpenInput["operation"];
        readonly agentId?: string;
        readonly options: CursorAgentSdkLoggedAgentOptions;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "agent.opened";
        readonly agentId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "run.start";
        readonly message: string | SDKUserMessage;
        readonly options: CursorAgentSdkLoggedSendOptions;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "run.resume";
        readonly options: CursorAgentSdkLoggedSendOptions;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "run.started";
        readonly runId: string;
        readonly agentId: string;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "interaction.update";
        readonly runId: string;
        readonly update: InteractionUpdate;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "run.completed";
        readonly result: RunResult;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "run.steer";
        readonly runId: string;
        readonly text: string;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "run.steered";
        readonly runId: string;
        readonly outcome: SteerAckOutcome;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "run.cancel";
        readonly runId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "agent.messages.list";
        readonly agentId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "agent.rewind";
        readonly agentId: string;
        readonly afterRunId: string;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "agent.messages";
        readonly agentId: string;
        readonly messages: ReadonlyArray<AgentMessage>;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "agent.close";
        readonly agentId: string;
      };
    };

export type CursorAgentSdkProtocolLogger = (
  event: CursorAgentSdkProtocolLogEvent,
) => Effect.Effect<void>;

function runnerError(cause: unknown, method: string): CursorAgentSdkRunnerError {
  return isCursorAgentSdkRunnerError(cause)
    ? cause
    : new CursorAgentSdkRunnerError({ method, cause });
}

function isActiveRunConflict(cause: unknown): boolean {
  return cause instanceof Error && /already has active run/i.test(cause.message);
}

export function isCursorCancellationError(cause: unknown): boolean {
  let current = cause;
  const seen = new Set<object>();

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (Reflect.get(current, "name") === "AbortError") {
      return true;
    }
    seen.add(current);
    current = Reflect.get(current, "cause");
  }

  return false;
}

export function loggedCursorAgentOptions(options: AgentOptions): CursorAgentSdkLoggedAgentOptions {
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.name === undefined ? {} : { hasName: true }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.local === undefined
      ? {}
      : {
          local: {
            ...(options.local.cwd === undefined ? {} : { hasCwd: true }),
            ...(options.local.autoReview === undefined
              ? {}
              : { autoReview: options.local.autoReview }),
            ...(options.local.settingSources === undefined
              ? {}
              : { settingSources: options.local.settingSources }),
            ...(options.local.sandboxOptions === undefined
              ? {}
              : { sandboxEnabled: options.local.sandboxOptions.enabled }),
            ...(options.local.enableAgentRetries === undefined
              ? {}
              : { enableAgentRetries: options.local.enableAgentRetries }),
            ...(options.local.customTools === undefined ? {} : { hasCustomTools: true }),
          },
        }),
    ...(options.agents === undefined ? {} : { agents: Object.keys(options.agents).toSorted() }),
  };
}

export function loggedCursorSendOptions(
  options: Omit<SendOptions, "onDelta"> | undefined,
): CursorAgentSdkLoggedSendOptions {
  if (options === undefined) {
    return {};
  }
  const mcpServerNames =
    options.mcpServers === undefined ? undefined : Object.keys(options.mcpServers).toSorted();
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(mcpServerNames === undefined ? {} : { hasMcpServers: true, mcpServerNames }),
    ...(options.local === undefined
      ? {}
      : {
          local: {
            ...(options.local.force === undefined ? {} : { force: options.local.force }),
            ...(options.local.customTools === undefined ? {} : { hasCustomTools: true }),
          },
        }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  };
}

export function makeCursorAgentSdkProtocolLogger(input: {
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): CursorAgentSdkProtocolLogger | undefined {
  if (input.nativeEventLogger === undefined) {
    return undefined;
  }
  const nativeEventLogger = input.nativeEventLogger;
  return (event) =>
    nativeEventLogger
      .write(
        {
          provider: CURSOR_PROVIDER,
          protocol: CURSOR_AGENT_SDK_PROTOCOL,
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event,
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
}

interface CursorShellStreamOutput {
  readonly conversationId?: unknown;
  readonly toolCallId?: unknown;
  readonly event: {
    readonly case: "stdout" | "stderr";
    readonly value: { readonly data: unknown };
  };
}

// The SDK reports shell-output-delta only for user-started shell commands, so
// patches/@cursor__sdk@1.2.0.patch publishes agent shell output on this hook.
const SHELL_STREAM_OUTPUT_HOOK = Symbol.for("@cursor/sdk.shellStreamOutput");
const shellStreamListeners = new Set<(output: CursorShellStreamOutput) => void>();

function subscribeShellStreamOutput(listener: (output: CursorShellStreamOutput) => void) {
  const hooks = globalThis as Record<symbol, unknown>;
  hooks[SHELL_STREAM_OUTPUT_HOOK] ??= (output: CursorShellStreamOutput) => {
    for (const notify of shellStreamListeners) notify(output);
  };
  shellStreamListeners.add(listener);
  return () => {
    shellStreamListeners.delete(listener);
  };
}

type CursorLocalStore = NonNullable<NonNullable<AgentOptions["local"]>["store"]>;

interface DisposableCursorLocalStore extends CursorLocalStore {
  readonly dispose: () => Promise<void>;
}

function isDisposableCursorLocalStore(value: unknown): value is DisposableCursorLocalStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "agents" in value &&
    "runs" in value &&
    "checkpoints" in value &&
    "runEvents" in value &&
    "dispose" in value &&
    typeof value.dispose === "function"
  );
}

// T3 persists its own event log and never tails SDK run_events; skipping per-delta SQLite
// run_events writes avoids synchronous BEGIN IMMEDIATE write locks and multi-GB index.db bloat.
export function withNoopCursorRunEvents(store: CursorLocalStore): CursorLocalStore {
  if (
    typeof store !== "object" ||
    store === null ||
    typeof store.runEvents?.append !== "function"
  ) {
    return store;
  }
  let seq = 0;
  return {
    agents: store.agents,
    runs: store.runs,
    checkpoints: store.checkpoints,
    runEvents: {
      append: async (event) => {
        seq += 1;
        return {
          runId: event.runId,
          seq,
          offset: String(seq),
          eventType: event.eventType,
          payload: event.payload ?? null,
          payloadRef: event.payloadRef ?? null,
          idempotencyKey: event.idempotencyKey ?? null,
          createdAt: 0,
        };
      },
      list: async () => ({ items: [] }),
      delete: async () => {},
    },
  };
}

interface CursorBackgroundShell {
  readonly conversationId?: unknown;
  readonly command?: unknown;
  readonly shell: {
    readonly id?: unknown;
    readonly pid?: unknown;
    readonly abort: () => void;
    readonly onComplete: (
      listener: (completion: {
        readonly code?: unknown;
        readonly aborted?: unknown;
        readonly outputPath?: unknown;
      }) => void,
    ) => void;
  };
}

// The SDK kills an agent's background shells when its run ends and reports their exit to no one.
// The @cursor/sdk patch offers each new one to this hook; true keeps it past the run.
const BACKGROUND_SHELL_HOOK = Symbol.for("@cursor/sdk.backgroundShell");
const backgroundShellListeners = new Map<string, (event: CursorBackgroundShellEvent) => void>();

function listenForBackgroundShells(
  agentId: string,
  listener: (event: CursorBackgroundShellEvent) => void,
) {
  const hooks = globalThis as Record<symbol, unknown>;
  hooks[BACKGROUND_SHELL_HOOK] ??= ({ conversationId, command, shell }: CursorBackgroundShell) => {
    const notify =
      typeof conversationId === "string" ? backgroundShellListeners.get(conversationId) : undefined;
    if (notify === undefined) return false;
    const ref = {
      id: String(shell.id),
      pid: typeof shell.pid === "number" ? shell.pid : undefined,
      command: typeof command === "string" ? command : "",
    };
    notify({ ...ref, type: "started", stop: () => shell.abort() });
    shell.onComplete((completion) =>
      notify({
        ...ref,
        type: "ended",
        stopped: completion.aborted === true,
        exitCode: typeof completion.code === "number" ? completion.code : undefined,
        outputPath: typeof completion.outputPath === "string" ? completion.outputPath : undefined,
      }),
    );
    return true;
  };
  backgroundShellListeners.set(agentId, listener);
}

export const makeCursorAgentSdkRunner = Effect.fn("makeCursorAgentSdkRunner")(function* (
  protocolLoggerFor: (input: CursorAgentSdkOpenInput) => CursorAgentSdkProtocolLogger | undefined,
) {
  const sdk = yield* CursorSdk.CursorSdk;

  // Prime with cursorsandbox before any Full access run; the SDK caches sandbox support per process.
  const sandboxSupportPrimeStarted = yield* Ref.make(false);
  const sandboxSupportPrimed = yield* Deferred.make<void>();
  const primeCursorSandboxSupport = Effect.fn("CursorAgentSdkRunner.primeSandboxSupport")(
    function* (options: AgentOptions) {
      if (yield* Ref.getAndSet(sandboxSupportPrimeStarted, true)) {
        return yield* Deferred.await(sandboxSupportPrimed);
      }
      yield* Effect.tryPromise({
        try: async () => {
          const cwd = typeof options.local?.cwd === "string" ? options.local.cwd : undefined;
          const platform = await sdk
            .load()
            .createAgentPlatform(cwd === undefined ? {} : { workspaceRef: cwd });
          const release = await platform.prewarmLocalWorkspace({
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            local: {
              ...(cwd === undefined ? {} : { cwd }),
              settingSources: [],
              sandboxOptions: { enabled: true },
            },
          });
          await release();
        },
        catch: (cause) => runnerError(cause, "prewarmLocalWorkspace"),
      }).pipe(Effect.ignore, Effect.ensuring(Deferred.succeed(sandboxSupportPrimed, undefined)));
    },
  );

  // Ref-count one SqliteLocalAgentStore per workspace so concurrent sessions share a single
  // index.db handle while still disposing handles, page caches, and FDs once the last one closes.
  interface WorkspaceStoreLease {
    readonly store: DisposableCursorLocalStore;
    readonly wrapped: CursorLocalStore;
    users: number;
  }
  const workspaceStores = new Map<string, WorkspaceStoreLease>();
  const workspaceStoreLock = yield* Semaphore.make(1);
  const acquireWorkspaceStore = (workspaceRef: string, method: string) =>
    workspaceStoreLock.withPermits(1)(
      Effect.suspend(() => {
        const existing = workspaceStores.get(workspaceRef);
        if (existing !== undefined) {
          existing.users += 1;
          return Effect.succeed(existing);
        }
        return Effect.tryPromise({
          try: async () => {
            const candidate = await sdk.loadSqlite().SqliteLocalAgentStore.open({ workspaceRef });
            return isDisposableCursorLocalStore(candidate) ? candidate : undefined;
          },
          catch: (cause) => runnerError(cause, method),
        }).pipe(
          Effect.map((opened) => {
            if (opened === undefined) return undefined;
            const lease: WorkspaceStoreLease = {
              store: opened,
              wrapped: withNoopCursorRunEvents(opened),
              users: 1,
            };
            workspaceStores.set(workspaceRef, lease);
            return lease;
          }),
        );
      }),
    );
  const releaseWorkspaceStore = (workspaceRef: string, lease: WorkspaceStoreLease) =>
    workspaceStoreLock.withPermits(1)(
      Effect.suspend(() => {
        lease.users -= 1;
        if (lease.users > 0) return Effect.void;
        if (workspaceStores.get(workspaceRef) === lease) {
          workspaceStores.delete(workspaceRef);
        }
        return Effect.tryPromise({
          try: () => lease.store.dispose(),
          catch: () => undefined,
        }).pipe(Effect.ignore);
      }),
    );

  return CursorAgentSdkRunner.of({
    open: Effect.fn("CursorAgentSdkRunner.open")(function* (input) {
      const { Agent, createAgentPlatform } = yield* Effect.try({
        try: sdk.load,
        catch: (cause) => runnerError(cause, `agent.${input.operation}`),
      });
      if (input.options.local?.sandboxOptions?.enabled === false) {
        yield* primeCursorSandboxSupport(input.options);
      }
      const protocolLogger = protocolLoggerFor(input);
      const log = (event: CursorAgentSdkProtocolLogEvent) =>
        protocolLogger === undefined ? Effect.void : protocolLogger(event);

      yield* log({
        direction: "outgoing",
        stage: "decoded",
        payload: {
          type: "agent.open",
          operation: input.operation,
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          options: loggedCursorAgentOptions(input.options),
        },
      });

      // Cursor uses cwd for both execution and store lookup; a moved thread keeps its original store.
      const cwd =
        typeof input.options.local?.cwd === "string"
          ? input.options.local.cwd
          : input.options.local?.cwd?.[0];
      const storeCwd = input.storeCwd;
      const storeWorkspace =
        input.operation === "resume" && storeCwd !== undefined ? storeCwd : cwd;
      const ownedStoreLease =
        input.options.local?.store === undefined && storeWorkspace !== undefined
          ? yield* acquireWorkspaceStore(storeWorkspace, `agent.${input.operation}`)
          : undefined;
      let storeReleased = false;
      const disposeOwnedStore =
        ownedStoreLease === undefined || storeWorkspace === undefined
          ? Effect.void
          : Effect.suspend(() => {
              if (storeReleased) return Effect.void;
              storeReleased = true;
              return releaseWorkspaceStore(storeWorkspace, ownedStoreLease);
            });
      const effectiveStore =
        ownedStoreLease === undefined ? input.options.local?.store : ownedStoreLease.wrapped;
      const effectiveOptions: AgentOptions =
        effectiveStore === undefined || effectiveStore === input.options.local?.store
          ? input.options
          : {
              ...input.options,
              local: {
                ...input.options.local,
                store: effectiveStore,
              },
            };

      const { storePlatform, agent } = yield* Effect.gen(function* () {
        const resolvedStorePlatform =
          input.operation === "resume" &&
          storeCwd !== undefined &&
          storeCwd !== input.options.local?.cwd
            ? yield* Effect.tryPromise({
                try: () =>
                  createAgentPlatform({
                    workspaceRef: storeCwd,
                    ...(effectiveStore === undefined ? {} : { localStore: effectiveStore }),
                  }),
                catch: (cause) => runnerError(cause, "agent.resume"),
              })
            : undefined;
        const openedAgent = yield* Effect.tryPromise({
          try: () =>
            input.operation === "create"
              ? Agent.create(effectiveOptions)
              : resolvedStorePlatform === undefined
                ? Agent.resume(input.agentId!, effectiveOptions)
                : resolvedStorePlatform.resumeAgent(input.agentId!, effectiveOptions),
          catch: (cause) => runnerError(cause, `agent.${input.operation}`),
        });
        yield* log({
          direction: "incoming",
          stage: "decoded",
          payload: {
            type: "agent.opened",
            agentId: openedAgent.agentId,
          },
        });
        return { storePlatform: resolvedStorePlatform, agent: openedAgent };
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? disposeOwnedStore : Effect.void)));
      let shellListener: ((event: CursorBackgroundShellEvent) => void) | undefined;

      const runOptions = {
        runtime: "local" as const,
        ...(cwd === undefined ? {} : { cwd }),
        ...(effectiveStore === undefined ? {} : { store: effectiveStore }),
      };
      let abandonedRunRecoveryAvailable = input.operation === "resume";
      const storeView = async () =>
        storePlatform ??
        (await createAgentPlatform({
          ...(cwd === undefined ? {} : { workspaceRef: cwd }),
          ...(effectiveStore === undefined ? {} : { localStore: effectiveStore }),
        }));

      return {
        agentId: agent.agentId,
        send: Effect.fn("CursorAgentSdkSession.send")(function* (sendInput) {
          const context = yield* Effect.context();
          const options = loggedCursorSendOptions(sendInput.options);
          yield* sendInput.resume === true
            ? log({
                direction: "outgoing",
                stage: "decoded",
                payload: { type: "run.resume", options },
              })
            : log({
                direction: "outgoing",
                stage: "decoded",
                payload: { type: "run.start", message: sendInput.message, options },
              });

          const onBackgroundShell = sendInput.onBackgroundShell;
          if (onBackgroundShell !== undefined) {
            let delivered = Promise.resolve();
            shellListener = (event) => {
              delivered = delivered
                .then(() => Effect.runPromiseWith(context)(onBackgroundShell(event)))
                .catch(() => undefined);
            };
            listenForBackgroundShells(agent.agentId, shellListener);
          }

          let callbacksReady = false;
          const pendingUpdates: Array<InteractionUpdate> = [];
          let callbackFailure: { readonly cause: unknown } | undefined;
          let callbackChain = Promise.resolve();
          let runId = "";
          const dispatchUpdate = (update: InteractionUpdate): Promise<void> => {
            callbackChain = callbackChain
              .then(() => {
                if (callbackFailure !== undefined) {
                  return;
                }
                return Effect.runPromiseWith(context)(
                  log({
                    direction: "incoming",
                    stage: "decoded",
                    payload: {
                      type: "interaction.update",
                      runId,
                      update,
                    },
                  }).pipe(Effect.andThen(sendInput.onDelta?.(update) ?? Effect.void)),
                );
              })
              .catch((cause) => {
                callbackFailure ??= { cause };
              });
            return callbackChain;
          };

          const startRun = () =>
            Effect.tryPromise({
              try: () => {
                if (sendInput.summarize === true) return agent.summarize();
                const options: SendOptions = {
                  ...sendInput.options,
                  onDelta: async ({ update }) => {
                    if (!callbacksReady) {
                      pendingUpdates.push(update);
                      return;
                    }
                    await dispatchUpdate(update);
                  },
                };
                if (sendInput.resume !== true) return agent.send(sendInput.message, options);
                if (agent.resume === undefined) {
                  throw new Error("This Cursor SDK agent cannot resume.");
                }
                return agent.resume(options);
              },
              catch: (cause) =>
                runnerError(cause, sendInput.resume === true ? "run.resume" : "run.start"),
            });
          const run = yield* startRun().pipe(
            Effect.catchIf(
              (error) => abandonedRunRecoveryAvailable && isActiveRunConflict(error.cause),
              (error) =>
                Effect.gen(function* () {
                  abandonedRunRecoveryAvailable = false;
                  // Local stores list runs oldest first, so the active run is on the
                  // last page and every page has to be read to reach it.
                  let activeRun: Run | undefined;
                  let cursor: string | undefined;
                  do {
                    const page = yield* Effect.tryPromise({
                      try: () =>
                        storePlatform === undefined
                          ? Agent.listRuns(agent.agentId, {
                              ...runOptions,
                              ...(cursor === undefined ? {} : { cursor }),
                            })
                          : storePlatform.listRuns(
                              agent.agentId,
                              cursor === undefined ? {} : { cursor },
                            ),
                      catch: (cause) => runnerError(cause, "agent.listRuns"),
                    });
                    activeRun =
                      page.items.findLast((candidate) => candidate.status === "running") ??
                      activeRun;
                    cursor = page.nextCursor;
                  } while (cursor !== undefined);
                  if (activeRun === undefined) {
                    return yield* error;
                  }
                  yield* log({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: { type: "run.cancel", runId: activeRun.id },
                  });
                  yield* Effect.tryPromise({
                    try: () =>
                      storePlatform === undefined
                        ? Agent.cancelRun(activeRun.id, runOptions)
                        : storePlatform.cancelRun(activeRun.id),
                    catch: (cause) => runnerError(cause, "agent.cancelRun"),
                  });
                  return yield* startRun();
                }),
            ),
          );
          abandonedRunRecoveryAvailable = false;
          runId = run.id;
          yield* log({
            direction: "incoming",
            stage: "decoded",
            payload: {
              type: "run.started",
              runId: run.id,
              agentId: run.agentId,
            },
          });
          callbacksReady = true;
          const unsubscribeShellOutput = subscribeShellStreamOutput((output) => {
            if (output.conversationId !== agent.agentId || typeof output.toolCallId !== "string") {
              return;
            }
            void dispatchUpdate({
              type: "shell-output-delta",
              event: { ...output.event, toolCallId: output.toolCallId },
            });
          });
          for (const update of pendingUpdates) {
            yield* Effect.tryPromise({
              try: () => dispatchUpdate(update),
              catch: (cause) => runnerError(cause, "run.onDelta"),
            });
          }

          return {
            runId: run.id,
            agentId: run.agentId,
            wait: Effect.tryPromise({
              try: async () => {
                const result = await run.wait();
                await callbackChain;
                if (callbackFailure !== undefined) {
                  throw callbackFailure.cause;
                }
                return result;
              },
              catch: (cause) => runnerError(cause, "run.wait"),
            }).pipe(
              Effect.ensuring(Effect.sync(unsubscribeShellOutput)),
              Effect.tap((result) =>
                log({
                  direction: "incoming",
                  stage: "decoded",
                  payload: {
                    type: "run.completed",
                    result,
                  },
                }),
              ),
            ),
            steer: Effect.fn("CursorAgentSdkRun.steer")((text: string) =>
              log({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "run.steer",
                  runId: run.id,
                  text,
                },
              }).pipe(
                Effect.andThen(
                  Effect.tryPromise({
                    try: () => run.steer?.(text) ?? Promise.resolve("revert_to_followup" as const),
                    catch: (cause) => runnerError(cause, "run.steer"),
                  }),
                ),
                Effect.tap((outcome) =>
                  log({
                    direction: "incoming",
                    stage: "decoded",
                    payload: {
                      type: "run.steered",
                      runId: run.id,
                      outcome,
                    },
                  }),
                ),
              ),
            ),
            cancel: log({
              direction: "outgoing",
              stage: "decoded",
              payload: {
                type: "run.cancel",
                runId: run.id,
              },
            }).pipe(
              Effect.andThen(
                Effect.tryPromise({
                  try: async () => {
                    try {
                      await run.cancel();
                    } catch (cause) {
                      if (!isCursorCancellationError(cause)) {
                        throw cause;
                      }
                    }
                  },
                  catch: (cause) => runnerError(cause, "run.cancel"),
                }),
              ),
            ),
          } satisfies CursorAgentSdkRun;
        }),
        listMessages: log({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "agent.messages.list",
            agentId: agent.agentId,
          },
        }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () =>
                storePlatform === undefined
                  ? Agent.messages.list(agent.agentId, {
                      runtime: "local",
                      ...(cwd === undefined ? {} : { cwd }),
                      ...(effectiveStore === undefined ? {} : { store: effectiveStore }),
                    })
                  : storePlatform.getAgentMessages(agent.agentId),
              catch: (cause) => runnerError(cause, "agent.messages.list"),
            }),
          ),
          Effect.tap((messages) =>
            log({
              direction: "incoming",
              stage: "decoded",
              payload: {
                type: "agent.messages",
                agentId: agent.agentId,
                messages,
              },
            }),
          ),
        ),
        readContextUsage: Effect.tryPromise({
          try: async () => (await storeView()).checkpointStore.loadLatest(agent.agentId),
          catch: (cause) => runnerError(cause, "agent.checkpoint.load"),
        }).pipe(
          Effect.map((checkpoint) => {
            const usage = Option.getOrUndefined(decodeCursorCheckpoint(checkpoint))?.tokenDetails;
            // An unset protobuf message reads as zeros.
            return usage === undefined || usage.maxTokens === 0 ? undefined : usage;
          }),
        ),
        runCheckpointed: (runId) =>
          Effect.tryPromise({
            try: async () => {
              const { store } = await storeView();
              let run: RunRecord | null | undefined;
              if (runId !== undefined) {
                run = await store.getRun(agent.agentId, runId);
              } else {
                let cursor: string | undefined;
                do {
                  const page = await store.listRuns(
                    agent.agentId,
                    cursor === undefined ? {} : { cursor },
                  );
                  for (const candidate of page.items) {
                    if (!run || candidate.turnNumber >= run.turnNumber) run = candidate;
                  }
                  cursor = page.nextCursor;
                } while (cursor !== undefined);
              }
              const checkpoint = run?.latestCheckpointRef?.blobId;
              return checkpoint !== undefined && checkpoint !== run?.startCheckpointRef?.blobId;
            },
            catch: (cause) => runnerError(cause, "agent.run.get"),
          }),
        rewindAfterRun: (runId) =>
          log({
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "agent.rewind", agentId: agent.agentId, afterRunId: runId },
          }).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: async () => {
                  const { store, checkpointStore } = await storeView();
                  const runs: Array<RunRecord> = [];
                  let cursor: string | undefined;
                  do {
                    const page = await store.listRuns(
                      agent.agentId,
                      cursor === undefined ? {} : { cursor },
                    );
                    runs.push(...page.items);
                    cursor = page.nextCursor;
                  } while (cursor !== undefined);
                  const kept = runs.find((candidate) => candidate.runId === runId);
                  if (kept === undefined) {
                    throw new Error(`Cursor agent ${agent.agentId} has no run ${runId}.`);
                  }
                  const unwound = runs
                    .filter((candidate) => candidate.turnNumber > kept.turnNumber)
                    .toSorted((a, b) => a.turnNumber - b.turnNumber)[0];
                  if (unwound === undefined) return;
                  const anchor = unwound.startCheckpointRef?.blobId;
                  if (anchor === undefined) {
                    throw new Error(`Cursor run ${unwound.runId} has no starting checkpoint.`);
                  }
                  const blobStore = await checkpointStore.getBlobStore(agent.agentId);
                  const getBlob =
                    typeof blobStore === "object" && blobStore !== null
                      ? Reflect.get(blobStore, "getBlob")
                      : undefined;
                  if (typeof getBlob !== "function") {
                    throw new Error("Cursor's checkpoint store cannot read blobs.");
                  }
                  const bytes: unknown = await getBlob.call(
                    blobStore,
                    undefined,
                    Buffer.from(anchor, "hex"),
                  );
                  if (!(bytes instanceof Uint8Array)) {
                    throw new Error(`Cursor checkpoint ${anchor} is missing.`);
                  }
                  // Checkpoints are content-addressed, so re-saving the anchor's bytes moves the
                  // agent's head back to that exact root, like cursor-agent's latestRootBlobId reset.
                  await checkpointStore.saveCheckpoint(agent.agentId, { toBinary: () => bytes });
                },
                catch: (cause) => runnerError(cause, "agent.rewind"),
              }),
            ),
          ),
        close: log({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "agent.close",
            agentId: agent.agentId,
          },
        }).pipe(
          Effect.andThen(
            Effect.try({
              try: () => {
                // A resumed session may already listen for this agent.
                if (backgroundShellListeners.get(agent.agentId) === shellListener) {
                  backgroundShellListeners.delete(agent.agentId);
                }
                agent.close();
              },
              catch: (cause) => runnerError(cause, "agent.close"),
            }),
          ),
          Effect.ensuring(disposeOwnedStore),
        ),
      } satisfies CursorAgentSdkSession;
    }),
    assertComplete: Effect.void,
  });
});

export const layer = Layer.effect(
  CursorAgentSdkRunner,
  Effect.gen(function* () {
    const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
    return yield* makeCursorAgentSdkRunner((input) =>
      makeCursorAgentSdkProtocolLogger({
        nativeEventLogger,
        threadId: input.threadId,
        providerSessionId: input.providerSessionId,
      }),
    );
  }),
);
