// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
// @effect-diagnostics anyUnknownInErrorContext:off
import { text } from "../unknownField.ts";

import {
  forkSession as forkClaudeSession,
  getSessionMessages,
  getSubagentMessages,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ForkSessionResult,
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import * as NodeChildProcess from "node:child_process";

import { AgentScope } from "@t3tools/shared/AgentScope";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Cause from "effect/Cause";

import * as SecureRandom from "effect/crypto/SecureRandom";

import * as Effect from "effect/Effect";

import * as Path from "effect/Path";

import * as Queue from "effect/Queue";

import * as Stream from "effect/Stream";

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PortScanner from "../../preview/PortScanner.ts";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";

import { CLAUDE_MCP_REGISTRATION_TIMEOUT } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_ROOT_REFUSAL } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_SCRIPT_EXTENSIONS } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_STDERR_DRAIN_TIMEOUT } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_STDERR_TAIL_LENGTH } from "./ClaudeProviderIdentity.ts";
import { ClaudeAgentSdkQueryRunner } from "./ClaudeAdapterV2.ts";
import { ClaudeCodeRootRefusalError } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeMcpRegistrationTimeoutError } from "./ClaudeQueryRunnerTypes.ts";
import { claudeConfigDirOf } from "./ClaudeQueryRunnerProtocol.ts";
import { claudeQueryMessages } from "./ClaudeQueryRunnerProtocol.ts";
import { closeClaudeQuery } from "./ClaudeQueryRunnerProtocol.ts";
import { forkClaudeSessionInWorker } from "./ClaudeQueryRunnerProtocol.ts";
import { isClaudeMcpRegistrationTimeoutError } from "./ClaudeQueryRunnerProtocol.ts";
import { loggedClaudeQueryOptions } from "./ClaudeQueryRunnerProtocol.ts";
import { makeClaudeAgentSdkProtocolLogger } from "./ClaudeQueryRunnerProtocol.ts";
import { queryRunnerError } from "./ClaudeQueryRunnerProtocol.ts";
import { spawnClaudeProcessGroup } from "./ClaudeProviderIdentity.ts";
import type { ClaudeAgentSdkProtocolLogEvent } from "./ClaudeQueryRunnerProtocol.ts";
import type { ClaudeAgentSdkQueryOpenInput } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQuerySession } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkSessionForkInput } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkSubagentLookupInput } from "./ClaudeQueryRunnerTypes.ts";

export const makeClaudeQueryRunnerLayer = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
  const agentScope = yield* AgentScope;
  const platform = yield* HostProcess.Platform;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const hostEnvironment = yield* HostProcess.Environment;
  const portDiscovery = yield* PortScanner.PortDiscovery;

  return ClaudeAgentSdkQueryRunner.of({
    allocateSessionId: random.uuidV4(),
    open: Effect.fn("ClaudeAgentSdkQueryRunner.open")(
      function* (input: ClaudeAgentSdkQueryOpenInput) {
        const protocolLogger = makeClaudeAgentSdkProtocolLogger({
          nativeEventLogger,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        });
        const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
          protocolLogger === undefined ? Effect.void : protocolLogger(event);
        // A failed open shuts down its queue before retrying, so the old CLI cannot take the prompt.
        const promptQueue = yield* Queue.unbounded<SDKUserMessage>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
          ),
          Stream.toAsyncIterable,
        );
        // Send MCP credentials over stdin to keep them out of SDK argv and inherited command environments.
        const { mcpServers, ...sdkOptions } = input.options;
        // Jobs the agent starts inherit the thread, so port discovery can attribute their servers.
        const queryOptions = {
          ...sdkOptions,
          env: {
            ...(sdkOptions.env ?? hostEnvironment),
            [PortScanner.AGENT_THREAD_ENV]: input.threadId,
          },
        };
        // The SDK can prepend a scope wrapper to native binaries; script entries run through node.
        const binaryPath = queryOptions.pathToClaudeCodeExecutable;
        const launch =
          binaryPath === undefined ||
          CLAUDE_SCRIPT_EXTENSIONS.some((ext) => binaryPath.endsWith(ext))
            ? undefined
            : yield* agentScope.wrap({
                command: binaryPath,
                args: [],
                name: "claude",
                threadId: input.threadId,
                env: queryOptions.env,
              });
        const options =
          launch === undefined || launch.args.length === 0
            ? queryOptions
            : {
                ...queryOptions,
                pathToClaudeCodeExecutable: launch.command,
                executableArgs: [...launch.args, ...(queryOptions.executableArgs ?? [])],
              };
        const unit = launch?.unit;
        const stopScope =
          unit === undefined ? undefined : () => void runFork(agentScope.stop(unit));
        // Only a CLI that fails before its first message explains itself on
        // stderr. The known root refusal becomes a curated failure; any other
        // stderr can hold private text, so it stays out of turn failures.
        let stderrTail = "";
        let stderrClosed: Promise<void> = Promise.resolve();
        let answered = false;
        const appendStderr = (text: string) => {
          if (answered) return;
          stderrTail = (stderrTail + text).slice(-CLAUDE_STDERR_TAIL_LENGTH);
        };
        const spawnProcess =
          options.spawnClaudeCodeProcess ??
          ((spawnOptions: ClaudeSpawnOptions) => {
            if (platform !== "win32") {
              // Node can report "exit" before it has read the stderr the CLI wrote.
              let stderrDone = () => {};
              stderrClosed = new Promise((resolve) => (stderrDone = resolve));
              return spawnClaudeProcessGroup(spawnOptions, stopScope, appendStderr, stderrDone);
            }
            const child = NodeChildProcess.spawn(spawnOptions.command, spawnOptions.args, {
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
              signal: spawnOptions.signal,
              windowsHide: true,
              stdio: ["pipe", "pipe", "pipe"],
            });
            child.stderr.setEncoding("utf8").on("data", (chunk: string) => options.stderr?.(chunk));
            return child;
          });
        let spawnedProcess: ClaudeSpawnedProcess | undefined;
        let processExited = false;
        let processExit: Promise<void> | undefined;
        const spawnClaudeCodeProcess = (spawnOptions: ClaudeSpawnOptions) => {
          const child = spawnProcess(spawnOptions);
          spawnedProcess = child;
          // A spawn that fails emits only "error".
          const releaseAgent = portDiscovery.trackAgent();
          child.once("exit", releaseAgent);
          child.on("error", releaseAgent);
          processExited = child.exitCode !== null || child.signalCode != null;
          processExit = new Promise<void>((resolve) => {
            if (processExited) resolve();
            else
              child.once("exit", () => {
                processExited = true;
                resolve();
              });
          });
          return child;
        };
        const queryRuntime = yield* Effect.uninterruptibleMask((restore) =>
          Effect.try({
            try: () =>
              query({
                prompt,
                options: { ...options, spawnClaudeCodeProcess },
              }),
            catch: (cause) => queryRunnerError(cause, "query"),
          }).pipe(
            Effect.tap((queryRuntime) =>
              restore(
                Effect.gen(function* () {
                  if (mcpServers !== undefined) {
                    // Errors and mcp_status can echo headers; log only server names.
                    const failed = yield* Effect.tryPromise(() =>
                      queryRuntime.setMcpServers(mcpServers),
                    ).pipe(
                      Effect.map((result) => Object.keys(result.errors)),
                      Effect.orElseSucceed(() => Object.keys(mcpServers)),
                      Effect.timeoutOrElse({
                        duration: CLAUDE_MCP_REGISTRATION_TIMEOUT,
                        orElse: () =>
                          Effect.logWarning("orchestration-v2.claude-mcp-registration-timeout", {
                            threadId: input.threadId,
                            providerSessionId: input.providerSessionId,
                          }).pipe(
                            Effect.andThen(
                              Effect.fail(
                                queryRunnerError(
                                  new ClaudeMcpRegistrationTimeoutError(),
                                  "setMcpServers",
                                ),
                              ),
                            ),
                          ),
                      }),
                    );
                    if (failed.length > 0) {
                      yield* Effect.logWarning("orchestration-v2.claude-mcp-servers-unavailable", {
                        threadId: input.threadId,
                        servers: failed,
                      });
                    }
                  }
                  yield* logProtocolEvent({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: {
                      type: "query.open",
                      options: loggedClaudeQueryOptions(input.options),
                    },
                  });
                }),
              ).pipe(
                Effect.onError(() =>
                  Queue.shutdown(promptQueue).pipe(
                    // SDK disposal can return before process exit; await the owned child's exit before retrying.
                    Effect.andThen(
                      Effect.tryPromise({
                        try: async () => {
                          if (spawnedProcess !== undefined && !processExited) {
                            spawnedProcess.kill("SIGKILL");
                          }
                          await processExit;
                        },
                        catch: (cause) => queryRunnerError(cause, "close"),
                      }).pipe(Effect.timeout("10 seconds")),
                    ),
                    Effect.ensuring(
                      Effect.tryPromise({
                        try: () => queryRuntime[Symbol.asyncDispose](),
                        catch: (cause) => queryRunnerError(cause, "close"),
                      }).pipe(Effect.orDie),
                    ),
                    Effect.orDie,
                  ),
                ),
              ),
            ),
          ),
        );

        return {
          messages: Stream.fromAsyncIterable(
            claudeQueryMessages(queryRuntime),
            (cause) => cause,
          ).pipe(
            Stream.catch((cause) =>
              Stream.fromEffect(
                Effect.gen(function* () {
                  if (!answered) {
                    yield* Effect.promise(() => stderrClosed).pipe(
                      Effect.timeoutOption(CLAUDE_STDERR_DRAIN_TIMEOUT),
                    );
                  }
                  const refusedRoot = !answered && stderrTail.includes(CLAUDE_ROOT_REFUSAL);
                  return yield* queryRunnerError(
                    refusedRoot ? new ClaudeCodeRootRefusalError({ cause }) : cause,
                    "fromAsyncIterable",
                  );
                }),
              ),
            ),
            Stream.tap(() =>
              Effect.sync(() => {
                answered = true;
              }),
            ),
            Stream.tap((message) =>
              logProtocolEvent({
                direction: "incoming",
                stage: "decoded",
                payload: message,
              }),
            ),
          ),
          offer: (message, onQueued) =>
            Effect.uninterruptibleMask((restore) =>
              restore(Queue.offer(promptQueue, message)).pipe(
                Effect.tap(() => Effect.sync(() => onQueued?.())),
              ),
            ).pipe(
              Effect.asVoid,
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "prompt.offer",
                    message,
                  },
                }),
              ),
            ),
          setModel: (model) =>
            Effect.tryPromise({
              try: () => queryRuntime.setModel(model),
              catch: (cause) => queryRunnerError(cause, "setModel"),
            }).pipe(
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "query.set_model",
                    model,
                  },
                }),
              ),
            ),
          applyFlagSettings: (settings) =>
            Effect.tryPromise({
              try: () => queryRuntime.applyFlagSettings(settings),
              catch: (cause) => queryRunnerError(cause, "applyFlagSettings"),
            }).pipe(
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "query.apply_flag_settings",
                    settings,
                  },
                }),
              ),
            ),
          setPermissionMode: (mode) =>
            Effect.tryPromise({
              try: () => queryRuntime.setPermissionMode(mode),
              catch: (cause) => queryRunnerError(cause, "setPermissionMode"),
            }).pipe(
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "query.set_permission_mode",
                    mode,
                  },
                }),
              ),
            ),
          stopTask: (taskId) =>
            Effect.tryPromise({
              try: () => queryRuntime.stopTask(taskId),
              catch: (cause) => queryRunnerError(cause, "stopTask"),
            }).pipe(
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: { type: "query.stop_task", taskId },
                }),
              ),
            ),
          backgroundTasks: (toolUseId) =>
            Effect.tryPromise({
              try: () => queryRuntime.backgroundTasks(toolUseId),
              catch: (cause) => queryRunnerError(cause, "backgroundTasks"),
            }).pipe(
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: { type: "query.background_tasks", toolUseId },
                }),
              ),
            ),
          interrupt: Effect.tryPromise({
            try: () => queryRuntime.interrupt(),
            catch: (cause) => queryRunnerError(cause, "interrupt"),
          }).pipe(
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "query.interrupt",
                },
              }),
            ),
          ),
          close: Queue.shutdown(promptQueue).pipe(
            Effect.andThen(closeClaudeQuery(queryRuntime)),
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "query.close",
                },
              }),
            ),
          ),
        } satisfies ClaudeAgentSdkQuerySession;
      },
      // Fresh IDs may already have a metadata-only transcript; only resumed opens can reuse their ID.
      (effect, input) =>
        effect.pipe(
          Effect.retry({
            times: 1,
            while: (error) =>
              input.options.resume !== undefined &&
              isClaudeMcpRegistrationTimeoutError(error.cause),
          }),
        ),
    ),
    forkSession: Effect.fn("ClaudeAgentSdkQueryRunner.forkSession")(function* (
      input: ClaudeAgentSdkSessionForkInput,
    ) {
      const protocolLogger = makeClaudeAgentSdkProtocolLogger({
        nativeEventLogger,
        threadId: input.threadId,
        providerSessionId: input.providerSessionId,
      });
      const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
        protocolLogger === undefined ? Effect.void : protocolLogger(event);
      yield* logProtocolEvent({
        direction: "outgoing",
        stage: "decoded",
        payload: {
          type: "session.fork",
          sessionId: input.sessionId,
          options: input.options,
        },
      });
      const hostEnvironment = yield* HostProcess.Environment;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const usesHostConfig =
        claudeConfigDirOf(path, input.environment, homeDirectory) ===
        claudeConfigDirOf(path, hostEnvironment, homeDirectory);
      const fork: Effect.Effect<ForkSessionResult & { readonly headMessageId?: string }, unknown> =
        usesHostConfig
          ? Effect.tryPromise(() => forkClaudeSession(input.sessionId, input.options))
          : forkClaudeSessionInWorker(input).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Path.Path, path),
            );
      const result = yield* fork.pipe(
        Effect.mapError((cause) => queryRunnerError(cause, "forkSession")),
      );
      yield* logProtocolEvent({
        direction: "incoming",
        stage: "decoded",
        payload: {
          type: "session.forked",
          sessionId: result.sessionId,
        },
      });
      // The SDK remaps copied UUIDs. Capture the inherited head before the
      // fork's first run appends messages.
      const headMessageId = usesHostConfig
        ? yield* Effect.tryPromise({
            try: () =>
              getSessionMessages(
                result.sessionId,
                input.options.dir === undefined ? {} : { dir: input.options.dir },
              ),
            catch: (cause) => queryRunnerError(cause, "getSessionMessages"),
          }).pipe(
            Effect.map((messages) => messages.at(-1)?.uuid),
            Effect.orElseSucceed(() => undefined),
          )
        : result.headMessageId;
      return headMessageId === undefined ? result : { ...result, headMessageId };
    }),
    subagentLaunchToolUseId: Effect.fn("ClaudeAgentSdkQueryRunner.subagentLaunchToolUseId")(
      function* (input: ClaudeAgentSdkSubagentLookupInput) {
        const protocolLogger = makeClaudeAgentSdkProtocolLogger({
          nativeEventLogger,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        });
        const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
          protocolLogger === undefined ? Effect.void : protocolLogger(event);
        yield* logProtocolEvent({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "subagent.lookup",
            sessionId: input.sessionId,
            agentId: input.agentId,
          },
        });
        const messages = yield* Effect.tryPromise({
          try: () =>
            getSubagentMessages(input.sessionId, input.agentId, {
              ...(input.dir === null ? {} : { dir: input.dir }),
              limit: 1,
            }),
          catch: (cause) => queryRunnerError(cause, "getSubagentMessages"),
        });
        const toolUseId = messages[0]?.parent_tool_use_id ?? null;
        yield* logProtocolEvent({
          direction: "incoming",
          stage: "decoded",
          payload: { type: "subagent.found", toolUseId },
        });
        return toolUseId;
      },
    ),
    assertComplete: Effect.void,
  });
});
