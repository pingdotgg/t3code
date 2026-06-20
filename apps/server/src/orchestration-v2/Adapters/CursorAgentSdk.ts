import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type InteractionUpdate,
  type RunResult,
  type SDKUserMessage,
  type SendOptions,
} from "@cursor/sdk";
import {
  type OrchestrationV2ProviderSession,
  ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import {
  type EventNdjsonLogger,
  makeEventNdjsonLogger,
} from "../../provider/Layers/EventNdjsonLogger.ts";

export const CURSOR_AGENT_SDK_PROTOCOL = "cursor-agent-sdk.local" as const;
export const CURSOR_PROVIDER = ProviderDriverKind.make("cursor");

export class CursorAgentSdkRunnerError extends Schema.TaggedErrorClass<CursorAgentSdkRunnerError>()(
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

const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdkRunnerError);

export interface CursorAgentSdkOpenInput {
  readonly operation: "create" | "resume";
  readonly agentId?: string;
  readonly options: AgentOptions;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface CursorAgentSdkSendInput<Error> {
  readonly message: string | SDKUserMessage;
  readonly options?: Omit<SendOptions, "onDelta">;
  readonly onDelta?: (update: InteractionUpdate) => Effect.Effect<void, Error>;
}

export interface CursorAgentSdkRun {
  readonly runId: string;
  readonly agentId: string;
  readonly wait: Effect.Effect<RunResult, CursorAgentSdkRunnerError>;
  readonly cancel: Effect.Effect<void, CursorAgentSdkRunnerError>;
}

export interface CursorAgentSdkSession {
  readonly agentId: string;
  readonly send: <Error>(
    input: CursorAgentSdkSendInput<Error>,
  ) => Effect.Effect<CursorAgentSdkRun, CursorAgentSdkRunnerError>;
  readonly listMessages: Effect.Effect<ReadonlyArray<AgentMessage>, CursorAgentSdkRunnerError>;
  readonly close: Effect.Effect<void, CursorAgentSdkRunnerError>;
}

export interface CursorAgentSdkRunnerShape {
  readonly open: (
    input: CursorAgentSdkOpenInput,
  ) => Effect.Effect<CursorAgentSdkSession, CursorAgentSdkRunnerError>;
  readonly assertComplete: Effect.Effect<void, CursorAgentSdkRunnerError>;
}

export class CursorAgentSdkRunner extends Context.Service<
  CursorAgentSdkRunner,
  CursorAgentSdkRunnerShape
>()("t3/orchestration-v2/Adapters/CursorAgentSdk/CursorAgentSdkRunner") {}

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
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
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
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
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

export const cursorAgentSdkRunnerLiveLayer: Layer.Layer<CursorAgentSdkRunner, never, ServerConfig> =
  Layer.effect(
    CursorAgentSdkRunner,
    Effect.gen(function* () {
      const { providerEventLogPath } = yield* ServerConfig;
      const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
        stream: "native",
      });

      return CursorAgentSdkRunner.of({
        open: Effect.fn("CursorAgentSdkRunner.open")(function* (input) {
          const protocolLogger = makeCursorAgentSdkProtocolLogger({
            nativeEventLogger,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          });
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

          const agent = yield* Effect.tryPromise({
            try: () =>
              input.operation === "create"
                ? Agent.create(input.options)
                : Agent.resume(input.agentId!, input.options),
            catch: (cause) => runnerError(cause, `agent.${input.operation}`),
          });

          yield* log({
            direction: "incoming",
            stage: "decoded",
            payload: {
              type: "agent.opened",
              agentId: agent.agentId,
            },
          });

          const cwd =
            typeof input.options.local?.cwd === "string"
              ? input.options.local.cwd
              : input.options.local?.cwd?.[0];

          return {
            agentId: agent.agentId,
            send: Effect.fn("CursorAgentSdkSession.send")(function* (sendInput) {
              const context = yield* Effect.context();
              yield* log({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "run.start",
                  message: sendInput.message,
                  options: loggedCursorSendOptions(sendInput.options),
                },
              });

              let callbacksReady = false;
              const pendingUpdates: Array<InteractionUpdate> = [];
              let callbackChain = Promise.resolve();
              let runId = "";
              const dispatchUpdate = (update: InteractionUpdate): Promise<void> => {
                callbackChain = callbackChain.then(() =>
                  Effect.runPromiseWith(context)(
                    log({
                      direction: "incoming",
                      stage: "decoded",
                      payload: {
                        type: "interaction.update",
                        runId,
                        update,
                      },
                    }).pipe(Effect.andThen(sendInput.onDelta?.(update) ?? Effect.void)),
                  ),
                );
                return callbackChain;
              };

              const run = yield* Effect.tryPromise({
                try: () =>
                  agent.send(sendInput.message, {
                    ...sendInput.options,
                    onDelta: async ({ update }) => {
                      if (!callbacksReady) {
                        pendingUpdates.push(update);
                        return;
                      }
                      await dispatchUpdate(update);
                    },
                  }),
                catch: (cause) => runnerError(cause, "run.start"),
              });
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
                    return result;
                  },
                  catch: (cause) => runnerError(cause, "run.wait"),
                }).pipe(
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
                    Agent.messages.list(agent.agentId, {
                      runtime: "local",
                      ...(cwd === undefined ? {} : { cwd }),
                    }),
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
            close: Effect.try({
              try: () => agent.close(),
              catch: (cause) => runnerError(cause, "agent.close"),
            }).pipe(
              Effect.tap(() =>
                log({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "agent.close",
                    agentId: agent.agentId,
                  },
                }),
              ),
            ),
          } satisfies CursorAgentSdkSession;
        }),
        assertComplete: Effect.void,
      });
    }),
  );
