// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
} from "../../provider/acp/XAiAcpExtension.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import {
  AcpProviderCapabilitiesV2,
  acpCanonicalJson,
  acpClaimNativeTransportRequest,
  acpNativeUserInputRequestMatches,
  acpPostSettleContinuationOfferEvidence,
  acpPostSettleMonitorPromptShouldSuppress,
  acpPostSettleWakeEvidence,
  acpPostSettleWakeShouldBuffer,
  acpProjectedCommandExitCode,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const testLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, serverConfigLayer);
const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

describe("acpProjectedCommandExitCode", () => {
  const successOutput = { type: "Bash", exit_code: 0 };
  const failedOutput = { type: "Bash", exit_code: 1 };

  it("omits exit codes for non-terminal and interrupted tool statuses", () => {
    assert.equal(acpProjectedCommandExitCode("pending", successOutput), undefined);
    assert.equal(acpProjectedCommandExitCode("running", successOutput), undefined);
    assert.equal(acpProjectedCommandExitCode("interrupted", successOutput), undefined);
  });

  it("projects real exit codes only for completed and failed tools", () => {
    assert.equal(acpProjectedCommandExitCode("completed", successOutput), 0);
    assert.equal(acpProjectedCommandExitCode("completed", failedOutput), 1);
    assert.equal(acpProjectedCommandExitCode("failed", failedOutput), 1);
    assert.equal(acpProjectedCommandExitCode("completed", {}), undefined);
  });
});

const taskkillPlatformError = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "taskkill-test", method });

function makeTaskkillSpawner(input: {
  readonly exitCode?: number;
  readonly exitFailure?: boolean;
  readonly output?: string;
  readonly outputFailure?: boolean;
  readonly spawnFailure?: boolean;
  readonly commands?: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
}) {
  return ChildProcessSpawner.make((command) => {
    const value = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    input.commands?.push({ command: value.command, args: value.args });
    if (input.spawnFailure === true) return Effect.fail(taskkillPlatformError("spawn"));
    const output = input.outputFailure
      ? Stream.fail(taskkillPlatformError("output"))
      : Stream.encodeText(Stream.make(input.output ?? ""));
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1234),
        exitCode: input.exitFailure
          ? Effect.fail(taskkillPlatformError("exitCode"))
          : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const waitForProcesses = (pids: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    while (!pids.every(processExists)) {
      yield* Effect.sleep("10 millis");
    }
  }).pipe(Effect.timeoutOption("2 seconds"));

const waitForProcessesToExit = (pids: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    while (pids.some(processExists)) {
      yield* Effect.sleep("10 millis");
    }
  }).pipe(Effect.timeoutOption("2 seconds"));

function linuxProcessStart(pid: number): string | undefined {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd < 0
      ? undefined
      : stat
          .slice(commandEnd + 2)
          .trim()
          .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function cleanupPublishedDetachedFixture(path: string): void {
  let published: Array<number>;
  try {
    published = NodeFS.readFileSync(path, "utf8")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  } catch {
    return;
  }
  const roots = published.filter((pid) => {
    try {
      return NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(path);
    } catch {
      return false;
    }
  });
  const owned = new Map<number, string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || owned.has(pid)) continue;
    const start = linuxProcessStart(pid);
    if (start === undefined) continue;
    owned.set(pid, start);
    try {
      pending.push(
        ...NodeFS.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number),
      );
    } catch {
      // The process already exited.
    }
  }
  for (const [pid, start] of [...owned.entries()].toReversed()) {
    if (linuxProcessStart(pid) !== start) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The exact fixture process already exited.
    }
  }
}

const waitForPublishedProcessIds = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  count: number,
) =>
  Effect.gen(function* () {
    while (true) {
      const ids = (yield* fileSystem.readFileString(path))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      if (ids.length === count && ids.every((pid) => Number.isSafeInteger(pid) && pid > 1)) {
        return ids;
      }
      yield* Effect.sleep("10 millis");
    }
  }).pipe(Effect.timeoutOption("2 seconds"));

function makeMockRuntime(input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
  readonly environment?:
    | Readonly<Record<string, string>>
    | ((runtimeOrdinal: number) => Readonly<Record<string, string>>);
  readonly protocolEvents?: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
  readonly ownDescendantProcessGroups?: boolean;
  readonly ownDetachedProcessGroup?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly linuxCgroupController?: AcpSessionRuntime.AcpSessionRuntimeOptions["linuxCgroupController"];
  readonly posixProcessTreeController?: AcpSessionRuntime.AcpSessionRuntimeOptions["posixProcessTreeController"];
  readonly windowsProcessTreeTerminator?: AcpSessionRuntime.AcpSessionRuntimeOptions["windowsProcessTreeTerminator"];
  readonly wrapCancel?: (
    cancel: AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"];
  readonly wrapOutgoingResponse?: (
    onOutgoingResponse: NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>,
  ) => NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>;
  readonly wrapIncomingRequest?: (
    onIncomingRequest: NonNullable<AcpAdapterV2RuntimeInput["onIncomingRequest"]>,
  ) => NonNullable<AcpAdapterV2RuntimeInput["onIncomingRequest"]>;
  readonly wrapRuntime?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    runtimeOrdinal: number,
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"];
}): AcpAdapterV2Flavor["makeRuntime"] {
  let runtimeOrdinal = 0;
  return (runtimeInput) =>
    Effect.gen(function* () {
      runtimeOrdinal += 1;
      const protocolEvents = input.protocolEvents;
      const protocolLogging =
        protocolEvents === undefined
          ? runtimeInput.protocolLogging
          : {
              ...runtimeInput.protocolLogging,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                Queue.offer(protocolEvents, event).pipe(
                  Effect.andThen(runtimeInput.protocolLogging.logger?.(event) ?? Effect.void),
                  Effect.asVoid,
                ),
            };
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          ...(input.ownDetachedProcessGroup === undefined
            ? {}
            : { ownDetachedProcessGroup: input.ownDetachedProcessGroup }),
          ...(input.ownDescendantProcessGroups === undefined
            ? {}
            : { ownDescendantProcessGroups: input.ownDescendantProcessGroups }),
          ...(input.ownDetachedProcessGroup === true
            ? { processGroupPlatform: input.processGroupPlatform ?? "linux" }
            : {}),
          ...(input.processGroupTerminationGrace === undefined
            ? {}
            : { processGroupTerminationGrace: input.processGroupTerminationGrace }),
          ...(input.linuxCgroupController === undefined
            ? {}
            : { linuxCgroupController: input.linuxCgroupController }),
          ...(input.posixProcessTreeController === undefined
            ? {}
            : { posixProcessTreeController: input.posixProcessTreeController }),
          ...(input.windowsProcessTreeTerminator === undefined
            ? {}
            : { windowsProcessTreeTerminator: input.windowsProcessTreeTerminator }),
          protocolLogging,
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: {
              T3_ACP_SESSION_LIFECYCLE: "1",
              ...(typeof input.environment === "function"
                ? input.environment(runtimeOrdinal)
                : input.environment),
            },
          },
          authMethodId: "test",
          ...(input.wrapIncomingRequest === undefined ||
          runtimeInput.onIncomingRequest === undefined
            ? {}
            : {
                onIncomingRequest: input.wrapIncomingRequest(runtimeInput.onIncomingRequest),
              }),
          ...(input.wrapOutgoingResponse === undefined ||
          runtimeInput.onOutgoingResponse === undefined
            ? {}
            : {
                onOutgoingResponse: input.wrapOutgoingResponse(runtimeInput.onOutgoingResponse),
              }),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const wrapped = {
        ...runtime,
        ...(input.wrapCancel === undefined ? {} : { cancel: input.wrapCancel(runtime.cancel) }),
      };
      return input.wrapRuntime?.(wrapped, runtimeOrdinal) ?? wrapped;
    });
}

function rawProtocolMethod(event: EffectAcpProtocol.AcpProtocolLogEvent): string | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      const method = (decoded as { readonly method?: unknown }).method;
      if (typeof method === "string") return method;
    }
  }
  return undefined;
}

function rawProtocolRequest(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): { readonly method?: unknown; readonly params?: unknown } | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      return decoded;
    }
  }
  return undefined;
}

const pollProtocolMethods = (events: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>) =>
  Effect.gen(function* () {
    const methods: string[] = [];
    let polled = 0;
    let event = yield* Queue.poll(events);
    while (Option.isSome(event) && polled < 256) {
      polled += 1;
      const method = rawProtocolMethod(event.value);
      if (method !== undefined) methods.push(method);
      event = yield* Queue.poll(events);
    }
    return methods;
  });

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly ordinal?: number;
  readonly modelSelection?: ModelSelection;
}): ProviderAdapterV2TurnInput {
  const ordinal = input.ordinal ?? 1;
  const suffix = `${input.threadId}:${ordinal}`;
  const modelSelection =
    input.modelSelection ?? ({ instanceId: input.instanceId, model: "default" } as const);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "ACP adapter test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}

describe("AcpAdapterV2", () => {
  it.live("cleans detached fixtures when an assertion aborts the test scope", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const fileSystem = yield* FileSystem.FileSystem;
      let published: ReadonlyArray<number> = [];
      const failed = yield* Effect.scoped(
        Effect.gen(function* () {
          const commandPidPath = yield* fileSystem.makeTempFileScoped({
            prefix: "t3-acp-forced-failure-command-",
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupPublishedDetachedFixture(commandPidPath)),
          );
          const fixture = NodeChildProcess.spawn(
            "bash",
            [
              "-c",
              'sleep 120 & child=$!; printf "%s %s\\n" "$$" "$child" > "$1"; wait "$child"',
              "bash",
              commandPidPath,
            ],
            { detached: true, stdio: "ignore" },
          );
          fixture.unref();
          published = Option.getOrThrow(
            yield* waitForPublishedProcessIds(fileSystem, commandPidPath, 2),
          );
          return yield* Effect.fail("forced assertion failure");
        }),
      ).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      assert.isTrue(
        Option.isSome(yield* waitForProcessesToExit(published)),
        "detached cleanup finalizer must reap the Bash and sleep fixture",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it("matches xAI native request identities exactly across shared prefixes", () => {
    const request = {
      nativeMethod: "x.ai/ask_user_question",
      nativeRequestId: "1",
      nativeSessionId: "session-1",
    };
    assert.isTrue(
      acpNativeUserInputRequestMatches(request, {
        method: "x.ai/ask_user_question",
        payload: { sessionId: "session-1", toolCallId: 1 },
      }),
    );
    assert.isFalse(
      acpNativeUserInputRequestMatches(request, {
        method: "x.ai/ask_user_question",
        payload: { sessionId: "session-1", toolCallId: "10", note: "request 1" },
      }),
    );
    for (const incomplete of [
      { ...request, nativeMethod: "" },
      { ...request, nativeRequestId: "" },
      { ...request, nativeSessionId: "" },
    ]) {
      assert.isFalse(
        acpNativeUserInputRequestMatches(incomplete, {
          method: "x.ai/ask_user_question",
          payload: { sessionId: "session-1", toolCallId: "1" },
        }),
      );
    }
    assert.isFalse(
      acpNativeUserInputRequestMatches(request, {
        method: "_x.ai/ask_user_question",
        payload: { sessionId: "session-1", toolCallId: "1" },
      }),
    );
    assert.isFalse(
      acpNativeUserInputRequestMatches(request, {
        method: "x.ai/ask_user_question",
        payload: {
          method: "x.ai/ask_user_question",
          params: { sessionId: "session-10", toolCallId: "1" },
        },
      }),
    );
  });

  it("claims concurrent identical native requests in per-runtime sequence order", () => {
    const requests = [
      { generation: 2, requestId: "second", sequence: 8, identity: "shared" },
      { generation: 1, requestId: "stale", sequence: 1, identity: "shared" },
      { generation: 2, requestId: "first", sequence: 7, identity: "shared" },
      { generation: 2, requestId: "other", sequence: 6, identity: "other" },
    ];
    const [firstId, afterFirst] = acpClaimNativeTransportRequest(
      requests,
      2,
      (request) => request.identity === "shared",
    );
    const [secondId, afterSecond] = acpClaimNativeTransportRequest(
      afterFirst,
      2,
      (request) => request.identity === "shared",
    );

    assert.equal(firstId, "first");
    assert.equal(secondId, "second");
    assert.deepEqual(
      afterSecond.map((request) => request.requestId),
      ["stale", "other"],
    );
  });

  it("canonicalizes nested elicitation schemas independently of object key order", () => {
    assert.equal(
      acpCanonicalJson({
        type: "object",
        properties: { answer: { type: "string", title: "Answer", enum: ["a", "b"] } },
      }),
      acpCanonicalJson({
        properties: { answer: { enum: ["a", "b"], title: "Answer", type: "string" } },
        type: "object",
      }),
    );
  });

  it.live("replaces an unexpectedly terminated ACP runtime before the next turn", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const runtimeInputs: AcpAdapterV2RuntimeInput[] = [];
      let runtimeOrdinalSeen = 0;
      const baseMakeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: (runtimeOrdinal) => {
          runtimeOrdinalSeen = runtimeOrdinal;
          return {};
        },
      });
      const instanceId = ProviderInstanceId.make("acp-test-unexpected-termination");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => {
              runtimeInputs.push(runtimeInput);
            }).pipe(Effect.andThen(baseMakeRuntime(runtimeInput))),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-unexpected-termination");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-unexpected-termination"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal(runtimeOrdinalSeen, 1);
      yield* runtimeInputs[0]!.onTermination!(
        new EffectAcpErrors.AcpTransportError({
          detail: "Injected unexpected writer termination",
          cause: "test",
        }),
      );

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(runtimeOrdinalSeen, 2);
      assert.lengthOf(runtimeInputs, 2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("reaps detached native work when the provider exits before explicit teardown", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const commandPidPath = yield* fileSystem.makeTempFileScoped({
        prefix: "t3-acp-provider-exit-command-",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => cleanupPublishedDetachedFixture(commandPidPath)),
      );
      const instanceId = ProviderInstanceId.make("acp-test-provider-exit");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDescendantProcessGroups: true,
            ownDetachedProcessGroup: true,
            processGroupTerminationGrace: 0,
            environment: {
              T3_ACP_EMIT_RUNNING_COMMAND_THEN_HANG: "1",
              T3_ACP_EXIT_AFTER_RUNNING_COMMAND_LAUNCH: "1",
              T3_ACP_RUNNING_COMMAND_PID_PATH: commandPidPath,
              T3_ACP_RUNNING_COMMAND_SEPARATE_SESSION: "1",
            },
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-provider-exit-running-command");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-provider-exit"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.exit, Effect.forkScoped);

      const published = yield* waitForPublishedProcessIds(fileSystem, commandPidPath, 3);
      assert.isTrue(Option.isSome(published), "detached fixture must publish all process IDs");
      const pids = Option.getOrThrow(published);
      assert.isTrue(
        Option.isSome(yield* waitForProcessesToExit(pids)),
        "provider termination must reap the detached launcher, Bash, and sleep processes",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("surfaces reduced guarantee when delegated cgroup containment is unavailable", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      let containment:
        | AcpSessionRuntime.AcpSessionRuntime["Service"]["processContainment"]
        | undefined;
      const instanceId = ProviderInstanceId.make("acp-test-cgroup-unavailable");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            linuxCgroupController: null,
            mockAgentPath,
            ownDescendantProcessGroups: true,
            ownDetachedProcessGroup: true,
            wrapRuntime: (runtime) => {
              containment = runtime.processContainment;
              return runtime;
            },
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-cgroup-unavailable");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-cgroup-unavailable"),
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      assert.equal(containment, "process-ledger-reduced-guarantee");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("cleans a cgroup lease when the pre-exec join wrapper fails", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      let createCalls = 0;
      let cgroupExists = true;
      let killCalls = 0;
      let removeCalls = 0;
      const cgroupController: AcpSessionRuntime.AcpLinuxCgroupController = {
        create: () => {
          createCalls += 1;
          return {
            contains: () => false,
            exists: () => cgroupExists,
            path: "/definitely-missing/t3-acp-cgroup",
            relativePath: "/definitely-missing/t3-acp-cgroup",
            kill: () => {
              killCalls += 1;
            },
            populated: () => false,
            remove: () => {
              removeCalls += 1;
              cgroupExists = false;
            },
          };
        },
      };
      const instanceId = ProviderInstanceId.make("acp-test-cgroup-join-failure");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            linuxCgroupController: cgroupController,
            mockAgentPath,
            ownDescendantProcessGroups: true,
            ownDetachedProcessGroup: true,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-cgroup-join-failure");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.make();
      const opened = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-cgroup-join-failure"),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope), Effect.exit);
      assert.isTrue(Exit.isFailure(opened));
      yield* Scope.close(sessionScope, Exit.void);
      assert.equal(createCalls, 1);
      assert.isAtLeast(killCalls, 1);
      assert.isAtLeast(removeCalls, 1);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("negotiates and executes optional native session forks through the ACP runtime", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const makeRuntime = makeMockRuntime({ childProcessSpawner, mockAgentPath, protocolEvents });

      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime,
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const sourceThreadId = ThreadId.make("thread-acp-native-fork-source");
      const targetThreadId = ThreadId.make("thread-acp-native-fork-target");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-acp-native-fork"),
        threadId: targetThreadId,
        providerSessionId: "mcp-session-acp-native-fork",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer target-thread-token",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(targetThreadId)),
      );
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId: sourceThreadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-native-fork"),
        modelSelection,
        runtimePolicy,
      });

      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);

      const sourceProviderThread = yield* runtime.ensureThread({
        threadId: sourceThreadId,
        modelSelection,
        runtimePolicy,
      });
      const forkedProviderThread = yield* runtime.forkThread({
        sourceProviderThread,
        targetThreadId,
      });
      const forkRequestEvent = Option.getOrThrow(
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "outgoing" && rawProtocolMethod(event) === "session/fork",
          ),
          Stream.runHead,
        ),
      );
      const forkRequest = Option.getOrThrow(
        Option.fromNullishOr(rawProtocolRequest(forkRequestEvent)),
      );

      assert.equal(sourceProviderThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, "mock-session-1-fork");
      assert.equal(forkedProviderThread.appThreadId, targetThreadId);
      assert.equal(forkedProviderThread.forkedFrom?.providerThreadId, sourceProviderThread.id);
      assert.deepEqual(forkRequest.params, {
        sessionId: "mock-session-1",
        cwd: process.cwd(),
        mcpServers: [
          {
            type: "http",
            name: "t3-code",
            url: "http://127.0.0.1:43123/mcp",
            headers: [{ name: "Authorization", value: "Bearer target-thread-token" }],
          },
        ],
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("closes an idle ACP session exactly once through the transition permit", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({ childProcessSpawner, mockAgentPath, protocolEvents }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-idle-finalizer");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.make();
      yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-idle-finalizer"),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      yield* pollProtocolMethods(protocolEvents);
      yield* Scope.close(sessionScope, Exit.void);
      const finalizerMethods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(finalizerMethods.filter((method) => method === "session/close").length, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects requested options that the active ACP session does not expose", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({ childProcessSpawner, mockAgentPath }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-unsupported-option");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const error = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-unsupported-option"),
          modelSelection: {
            instanceId,
            model: "default",
            options: [{ id: "missing-option", value: "high" }],
          },
          runtimePolicy,
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterOpenSessionError");
      assert.include(String(error.cause), "does not expose requested configuration option(s)");
      assert.include(String(error.cause), "missing-option");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("reconfigures a loaded ACP session from its own active setup metadata", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({ childProcessSpawner, mockAgentPath, protocolEvents }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const firstThreadId = ThreadId.make("thread-acp-active-setup:first");
      const secondThreadId = ThreadId.make("thread-acp-active-setup:second");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const initialSelection = { instanceId, model: "default" } satisfies ModelSelection;
      const alternateSelection = {
        instanceId,
        model: "grok-mock-alt",
      } satisfies ModelSelection;
      const originalSelection = { instanceId, model: "grok-build" } satisfies ModelSelection;
      const runtime = yield* adapter.openSession({
        threadId: firstThreadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-active-setup"),
        modelSelection: initialSelection,
        runtimePolicy,
      });
      const firstProviderThread = yield* runtime.ensureThread({
        threadId: firstThreadId,
        modelSelection: initialSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId: firstThreadId,
          providerThread: firstProviderThread,
          instanceId,
          runtimePolicy,
          modelSelection: alternateSelection,
          now,
        }),
      );
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );

      const secondProviderThread: OrchestrationV2ProviderThread = {
        ...firstProviderThread,
        id: ProviderThreadId.make("provider-thread-acp-active-setup:second"),
        appThreadId: secondThreadId,
        nativeThreadRef: {
          driver: ACP_TEST_DRIVER,
          nativeId: "mock-session-2",
          strength: "strong",
        },
        status: "idle",
      };
      yield* runtime.resumeThread({
        providerThread: secondProviderThread,
        modelSelection: alternateSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId: secondThreadId,
          providerThread: secondProviderThread,
          instanceId,
          runtimePolicy,
          modelSelection: originalSelection,
          now,
          ordinal: 2,
        }),
      );
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );

      const setModelRequests = Array.from(yield* Queue.takeAll(protocolEvents)).filter(
        (event) =>
          event.direction === "outgoing" && rawProtocolMethod(event) === "session/set_model",
      );
      assert.lengthOf(setModelRequests, 2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("terminalizes an empty successful foreground Bash tool when the turn completes", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: (runtimeOrdinal) =>
              runtimeOrdinal === 1 ? { T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH_THEN_HANG: "1" } : {},
            ownDetachedProcessGroup: true,
            protocolEvents,
          }),
          normalizeToolCall: normalizeXAiAcpToolCallState,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-empty-successful-bash");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-empty-successful-bash"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );

      const statuses: string[] = [];
      let runningStartedAt: DateTime.Utc | null = null;
      let completedStartedAt: DateTime.Utc | null = null;
      let completedAt: DateTime.Utc | null = null;
      let completedInput: string | null = null;
      let completedOutput: string | null | undefined;
      let completedExitCode: number | null | undefined;
      let runningProjectedExitCode: number | undefined = undefined;
      let terminal = false;
      while (!terminal) {
        const event = yield* Queue.take(events);
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tool-call-empty-success-1"
        ) {
          statuses.push(event.turnItem.status);
          if (event.turnItem.status === "running") {
            runningStartedAt ??= event.turnItem.startedAt;
            if (event.turnItem.type === "command_execution") {
              runningProjectedExitCode = event.turnItem.exitCode;
            }
          }
          if (event.turnItem.status === "completed") {
            completedStartedAt = event.turnItem.startedAt;
            completedAt = event.turnItem.completedAt;
            if (event.turnItem.type === "command_execution") {
              completedInput = event.turnItem.input;
              completedOutput = event.turnItem.output;
              completedExitCode = event.turnItem.exitCode;
            }
          }
        }
        if (event.type === "turn.terminal") terminal = true;
      }

      assert.deepEqual(statuses, ["running", "running", "completed"]);
      assert.deepEqual(completedStartedAt, runningStartedAt);
      assert.isNotNull(completedAt);
      assert.equal(completedInput, "true");
      assert.equal(completedOutput, undefined);
      assert.equal(
        runningProjectedExitCode,
        undefined,
        "mid-stream exit_code must not project until the tool is terminal",
      );
      assert.equal(completedExitCode, 0);

      yield* Queue.takeAll(protocolEvents);
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:2",
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: secondProviderTurnId,
        requestRuntimeRestart: true,
      });
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 3 }),
      );
      const loadAfterRestart = yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) => event.direction === "outgoing" && rawProtocolMethod(event) === "session/load",
        ),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(loadAfterRestart));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("cancels pending permission requests while interrupting an ACP turn", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const releaseCancel = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            wrapCancel: (cancel) => Deferred.await(releaseCancel).pipe(Effect.andThen(cancel)),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-cancel-permission");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-cancel-permission"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );

      const pendingRequest = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pendingRequest.type !== "runtime_request.updated" ||
        pendingRequest.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending ACP permission request with a provider turn");
      }

      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pendingRequest.runtimeRequest.providerTurnId,
        })
        .pipe(Effect.forkScoped);

      const cancelledRequest = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.id === pendingRequest.runtimeRequest.id &&
              event.runtimeRequest.status === "cancelled",
          ),
          Stream.runHead,
        ),
      );
      assert.equal(cancelledRequest.type, "runtime_request.updated");
      yield* Deferred.succeed(releaseCancel, undefined);
      yield* Fiber.join(interruptFiber);
      const terminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        ),
      );
      assert.equal(terminal.type, "turn.terminal");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("keeps hard teardown excluded until a permission response is enqueued", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseEnqueued = yield* Deferred.make<void>();
      const releaseResponseAcknowledgement = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseEnqueued, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-response-wins-permission");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-response-wins-permission"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pending.type !== "runtime_request.updated" ||
        pending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(responseEnqueued);
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pending.runtimeRequest.providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(responseFiber.pollUnsafe());
      assert.isUndefined(interruptFiber.pollUnsafe());

      yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
      yield* Fiber.join(responseFiber);
      yield* Fiber.join(interruptFiber);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("correlates reordered elicitation schemas through the completed stdout write", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseWritten = yield* Deferred.make<void>();
      const releaseResponseAcknowledgement = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test-reordered-elicitation");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_ELICITATION: "1" },
            wrapIncomingRequest: (onIncomingRequest) => (requestId, method, payload) => {
              if (method !== "session/elicitation") {
                return onIncomingRequest(requestId, method, payload);
              }
              const record = payload as Record<string, unknown>;
              return onIncomingRequest(requestId, method, {
                ...record,
                requestedSchema: {
                  properties: {
                    approved: { title: "Approved", type: "boolean" },
                  },
                  type: "object",
                },
              });
            },
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseWritten, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-reordered-elicitation");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-reordered-elicitation"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (pending.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected a pending elicitation request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          answers: { approved: ["true"] },
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(responseWritten);
      assert.isUndefined(responseFiber.pollUnsafe());
      yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
      yield* Fiber.join(responseFiber);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("fails a held native response acknowledgement before normal session close", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseWritten = yield* Deferred.make<void>();
      const releaseResponseAcknowledgement = yield* Deferred.make<void>();
      const responseLifecycle: Array<string> = [];
      const instanceId = ProviderInstanceId.make("acp-test-normal-close-held-response");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseWritten, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
        testHooks: {
          onNativeResponseLifecycle: (event) =>
            Effect.sync(() => {
              responseLifecycle.push(event.type);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-normal-close-held-response");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-normal-close-held-response",
          ),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (pending.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(responseWritten);

      const closeFiber = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkScoped);
      while (!responseLifecycle.includes("failed")) {
        yield* Effect.yieldNow;
      }
      const responseExit = yield* Fiber.join(responseFiber);
      if (Exit.isSuccess(responseExit)) {
        assert.fail("normal close must fail a response whose transport acknowledgement is held");
      }
      assert.include(Cause.pretty(responseExit.cause), "ACP session transport closed");
      assert.include(responseLifecycle, "removed");
      assert.include(responseLifecycle, "failed");
      yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
      yield* Fiber.join(closeFiber);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("rejects delayed native response registration when normal close wins the permit", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const registrationStarted = yield* Deferred.make<void>();
      const releaseRegistration = yield* Deferred.make<void>();
      const transportClosed = yield* Deferred.make<void>();
      const releaseTransportClose = yield* Deferred.make<void>();
      const responseLifecycle: Array<string> = [];
      const instanceId = ProviderInstanceId.make("acp-test-close-wins-registration");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
        testHooks: {
          afterNativeResponseTransportClosed: () =>
            Deferred.succeed(transportClosed, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTransportClose)),
            ),
          beforeNativeResponseAdmissionCheck: () =>
            Deferred.succeed(registrationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRegistration)),
            ),
          onNativeResponseLifecycle: (event) =>
            Effect.sync(() => {
              responseLifecycle.push(event.type);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-close-wins-registration");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-close-wins-registration"),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (pending.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(registrationStarted);

      const closeFiber = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(transportClosed);
      yield* Deferred.succeed(releaseRegistration, undefined);
      while (!responseLifecycle.includes("admission_rejected")) {
        yield* Effect.yieldNow;
      }
      const responseExit = yield* Fiber.join(responseFiber);
      if (Exit.isSuccess(responseExit)) {
        assert.fail("normal close must reject a response delayed before transport registration");
      }
      assert.include(Cause.pretty(responseExit.cause), "ACP session transport closed");
      assert.equal(responseLifecycle.filter((event) => event === "registered").length, 1);
      assert.equal(responseLifecycle.filter((event) => event === "removed").length, 1);
      assert.equal(responseLifecycle.filter((event) => event === "admission_rejected").length, 1);
      yield* Deferred.succeed(releaseTransportClose, undefined);
      yield* Fiber.join(closeFiber);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("bounds a missing pending permission response acknowledgement", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseEnqueued = yield* Deferred.make<void>();
      const releaseNativeHook = yield* Deferred.make<void>();
      const responseLifecycle: Array<string> = [];
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test-pending-response-timeout");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: {
              T3_ACP_EMIT_TOOL_CALLS: "1",
              T3_ACP_HANG_AFTER_PERMISSION: "1",
            },
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            protocolEvents,
            windowsProcessTreeTerminator: (pid) =>
              Deferred.succeed(releaseNativeHook, undefined).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    process.kill(pid, "SIGTERM");
                  }),
                ),
              ),
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseEnqueued, undefined).pipe(
                Effect.andThen(Deferred.await(releaseNativeHook)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
        testHooks: {
          onNativeResponseLifecycle: (event) =>
            Effect.sync(() => {
              responseLifecycle.push(event.type);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-pending-response-timeout");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-pending-response-timeout",
          ),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      yield* pollProtocolMethods(protocolEvents);
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pending.type !== "runtime_request.updated" ||
        pending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseExit = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.exit);
      if (Exit.isSuccess(responseExit)) {
        assert.fail("missing native response acknowledgement must fail the pending response");
      }
      assert.include(Cause.pretty(responseExit.cause), "Native response acknowledgement timed out");
      assert.isTrue(yield* Deferred.isDone(responseEnqueued));
      assert.isFalse(yield* Deferred.isDone(releaseNativeHook));
      assert.isBelow(responseLifecycle.indexOf("removed"), responseLifecycle.indexOf("failed"));
      assert.includeMembers(responseLifecycle, [
        "registered",
        "removed",
        "failed",
        "timer_exited",
        "timer_started",
        "watcher_exited",
        "watcher_started",
      ]);

      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: pending.runtimeRequest.providerTurnId,
        requestRuntimeRestart: true,
      });
      assert.isTrue(yield* Deferred.isDone(releaseNativeHook));
      yield* Effect.sleep("50 millis");
      assert.include(responseLifecycle, "late_noop");
      yield* Scope.close(sessionScope, Exit.void);
      assert.notInclude(yield* pollProtocolMethods(protocolEvents), "session/close");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("defers caller cancellation until a pending response acknowledgement is bounded", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseEnqueued = yield* Deferred.make<void>();
      const releaseNativeHook = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test-pending-response-cancel");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: {
              T3_ACP_EMIT_TOOL_CALLS: "1",
              T3_ACP_HANG_AFTER_PERMISSION: "1",
            },
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: (pid) =>
              Deferred.succeed(releaseNativeHook, undefined).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    process.kill(pid, "SIGTERM");
                  }),
                ),
              ),
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseEnqueued, undefined).pipe(
                Effect.andThen(Deferred.await(releaseNativeHook)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-pending-response-cancel");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-pending-response-cancel"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pending.type !== "runtime_request.updated" ||
        pending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(responseEnqueued);
      const cancellationFiber = yield* Fiber.interrupt(responseFiber).pipe(Effect.forkScoped);
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pending.runtimeRequest.providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.sleep("100 millis");
      assert.isUndefined(cancellationFiber.pollUnsafe());
      assert.isUndefined(interruptFiber.pollUnsafe());
      assert.isFalse(yield* Deferred.isDone(releaseNativeHook));

      yield* Fiber.join(cancellationFiber);
      yield* Fiber.join(interruptFiber);
      assert.isTrue(yield* Deferred.isDone(releaseNativeHook));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("waits for immediate allow and deny permission responses before hard teardown", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );

      for (const [name, sandboxPolicy] of [
        ["allow", undefined],
        ["deny", { type: "readOnly" } as const],
      ] as const) {
        yield* Effect.gen(function* () {
          const responseEnqueued = yield* Deferred.make<void>();
          const releaseResponseAcknowledgement = yield* Deferred.make<void>();
          const instanceId = ProviderInstanceId.make(`acp-test-${name}`);
          const adapter = makeAcpAdapterV2({
            crypto: yield* Crypto.Crypto,
            instanceId,
            flavor: {
              driver: ACP_TEST_DRIVER,
              capabilities: AcpProviderCapabilitiesV2,
              restartRuntimeAfterInterrupt: true,
              terminateRuntimeProcessGroupOnInterrupt: true,
              makeRuntime: makeMockRuntime({
                childProcessSpawner,
                mockAgentPath,
                environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
                ownDetachedProcessGroup: true,
                processGroupPlatform: "win32",
                windowsProcessTreeTerminator: (pid) =>
                  Effect.sync(() => {
                    process.kill(pid, "SIGTERM");
                  }),
                wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
                  Deferred.succeed(responseEnqueued, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                    Effect.andThen(onOutgoingResponse(requestId)),
                  ),
              }),
            },
            fileSystem,
            idAllocator,
            serverConfig,
          });
          const threadId = ThreadId.make(`thread-acp-immediate-permission-${name}`);
          const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            approvalPolicy: "never",
            cwd: process.cwd(),
            ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
          });
          const modelSelection = { instanceId, model: "default" } as const;
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              `provider-session-acp-immediate-permission-${name}`,
            ),
            modelSelection,
            runtimePolicy,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const turnFiber = yield* runtime
            .startTurn(
              makeTurnInput({
                threadId,
                providerThread,
                instanceId,
                runtimePolicy,
                now: yield* DateTime.now,
              }),
            )
            .pipe(Effect.forkDetach);
          yield* Deferred.await(responseEnqueued);
          const interruptFiber = yield* runtime
            .interruptTurn({
              providerThread,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: ACP_TEST_DRIVER,
                nativeTurnId: "mock-session-1:turn:1",
              }),
              requestRuntimeRestart: true,
            })
            .pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          assert.isUndefined(interruptFiber.pollUnsafe());

          yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
          yield* Fiber.join(interruptFiber);
          yield* Fiber.interrupt(turnFiber).pipe(Effect.forkDetach);
        }).pipe(Effect.scoped);
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("waits for immediate URL elicitation responses before hard teardown", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseEnqueued = yield* Deferred.make<void>();
      const releaseResponseAcknowledgement = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test-url-elicitation");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_URL_ELICITATION: "1" },
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: (pid) =>
              Effect.sync(() => {
                process.kill(pid, "SIGTERM");
              }),
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseEnqueued, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-immediate-url-elicitation");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-immediate-url-elicitation"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const turnFiber = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkDetach);
      yield* Deferred.await(responseEnqueued);
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ACP_TEST_DRIVER,
            nativeTurnId: "mock-session-1:turn:1",
          }),
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(interruptFiber.pollUnsafe());

      yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
      yield* Fiber.join(interruptFiber);
      yield* Fiber.interrupt(turnFiber).pipe(Effect.forkDetach);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("bounds a missing immediate response acknowledgement before hard teardown", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseEnqueued = yield* Deferred.make<void>();
      const releaseNativeHook = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test-missing-response-ack");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: (pid) =>
              Deferred.succeed(releaseNativeHook, undefined).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    process.kill(pid, "SIGTERM");
                  }),
                ),
              ),
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseEnqueued, undefined).pipe(
                Effect.andThen(Deferred.await(releaseNativeHook)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-missing-response-ack");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        approvalPolicy: "never",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-missing-response-ack"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const turnFiber = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkDetach);
      yield* Deferred.await(responseEnqueued);
      const startedAt = yield* Clock.currentTimeMillis;
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        }),
        requestRuntimeRestart: true,
      });
      assert.isAtLeast((yield* Clock.currentTimeMillis) - startedAt, 1_500);
      yield* Fiber.interrupt(turnFiber).pipe(Effect.forkDetach);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("rejects an elicitation response when hard teardown wins admission", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const teardownStarted = yield* Deferred.make<void>();
      const releaseTeardown = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_ELICITATION: "1" },
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: (pid) =>
              Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTeardown)),
                Effect.andThen(
                  Effect.sync(() => {
                    process.kill(pid, "SIGTERM");
                  }),
                ),
              ),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-teardown-wins-elicitation");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-teardown-wins-elicitation"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pending.type !== "runtime_request.updated" ||
        pending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending elicitation request");
      }
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pending.runtimeRequest.providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(teardownStarted);
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          answers: { approved: ["true"] },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(responseFiber.pollUnsafe());

      yield* Deferred.succeed(releaseTeardown, undefined);
      yield* Fiber.join(interruptFiber);
      const responseExit = yield* Fiber.join(responseFiber);
      if (Exit.isSuccess(responseExit)) {
        assert.fail("teardown winning admission must reject the elicitation response");
      }
      assert.include(Cause.pretty(responseExit.cause), "No pending ACP runtime request");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("releases an ACP turn when cancellation times out", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test");
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_PROMPT_DELAY_MS: "5000" },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-cancel-timeout");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-cancel-timeout"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const firstTurn = makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now,
      });
      yield* runtime.startTurn(firstTurn);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/cancel",
        ),
        Stream.runHead,
      );
      yield* TestClock.adjust("10 seconds");
      const interruptError = yield* Fiber.join(interruptFiber);
      assert.equal(interruptError._tag, "ProviderAdapterInterruptError");

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now,
          ordinal: 2,
        }),
      );
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("treats a second hard Stop as success when the turn is already gone", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: false,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-double-stop");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-double-stop"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }))
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId,
        requestRuntimeRestart: true,
      });
      // Second durable interrupt after activeTurn is cleared must not fail.
      const second = yield* Effect.exit(
        runtime.interruptTurn({
          providerThread,
          providerTurnId,
          requestRuntimeRestart: true,
        }),
      );
      assert.isTrue(Exit.isSuccess(second), "duplicate hard Stop must be idempotent");
      let terminal: string | null = null;
      while (terminal === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminal = event.status;
        }
      }
      assert.equal(terminal, "interrupted");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("finalizes a settled turn held open for background work when interrupted", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          deferFinalizeForBackgroundWork: true,
          extractSubagentUpdate: (toolCall) =>
            toolCall.toolCallId === "tool-call-generic-1"
              ? {
                  nativeTaskId: "task-generic-1",
                  prompt: "background subagent",
                  title: "background subagent",
                  model: null,
                  status: "running",
                  childSessionId: null,
                  result: null,
                }
              : undefined,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-interrupt-background-hold");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-interrupt-background"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );
      // The still-running subagent defers finalize after session/prompt returns.
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "raw" &&
            typeof event.payload === "string" &&
            event.payload.includes('"stopReason"'),
        ),
        Stream.runHead,
      );
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(interruptFiber);

      let terminalStatus: string | null = null;
      while (terminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminalStatus = event.status;
        }
      }
      assert.equal(terminalStatus, "interrupted");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "carries a live subagent lineage across an interrupt so the next turn can complete it",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : // Hydration-only shape (empty prompt, null title): without a
                    // carried-over lineage this update is dropped and the item
                    // stays running forever.
                    {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
              protocolEvents,
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
        });
        const threadId = ThreadId.make("thread-acp-subagent-carryover");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-subagent-carryover"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes('"stopReason"'),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });
        const interruptFiber = yield* runtime
          .interruptTurn({ providerThread, providerTurnId: firstProviderTurnId })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        let subagentTurnItemId: string | null = null;
        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentTurnItemId = event.turnItem.id;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.notEqual(subagentTurnItemId, null);

        subagentPhase = "complete";
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:2",
        });
        let carriedItemStatus: string | null = null;
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.id === subagentTurnItemId
          ) {
            carriedItemStatus = event.turnItem.status;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(carriedItemStatus, "completed");
        assert.equal(secondTerminalStatus, "completed");
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "pins hasPendingBackgroundWork while carryover holds a live subagent after root settle",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            enablePostSettleContinuation: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
              protocolEvents,
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
          continuationRequests: { offer: () => Effect.void },
        });
        const threadId = ThreadId.make("thread-acp-carryover-pending-pin");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-carryover-pending-pin"),
          modelSelection,
          runtimePolicy,
        });
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die(
            "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
          );
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes('"stopReason"'),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });
        const interruptFiber = yield* runtime
          .interruptTurn({ providerThread, providerTurnId: firstProviderTurnId })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        // Root settled with a live projected subagent in carryover: pin idle release.
        assert.isTrue(
          yield* hasPendingBackgroundWork,
          "carryover live subagent must pin hasPendingBackgroundWork after root settle",
        );

        subagentPhase = "complete";
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:2",
        });
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(secondTerminalStatus, "completed");
        // Carryover is consumed into the next turn and terminalized; pin clears.
        assert.isFalse(
          yield* hasPendingBackgroundWork,
          "hasPendingBackgroundWork must clear after carryover subagent terminals",
        );
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "preserveRuntimeOnSettledInterrupt keeps the process alive and carries subagents through a settled steering interrupt",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        let cancelCalled = false;
        let runtimeOrdinalSeen = 0;
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            // Hard interrupt flags (stricter than production Grok, which no
            // longer sets restartRuntimeOnEveryInterrupt): every interrupt
            // would hard-kill the process group without the settled-soft gate
            // under test.
            restartRuntimeAfterInterrupt: true,
            restartRuntimeOnEveryInterrupt: true,
            terminateRuntimeProcessGroupOnInterrupt: true,
            preserveRuntimeOnSettledInterrupt: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            // No ownDetachedProcessGroup: if the interrupt wrongly takes the
            // hard path, terminateProcessGroup is missing and the interrupt
            // fails loudly with a poisoned session.
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: (runtimeOrdinal) => {
                runtimeOrdinalSeen = Math.max(runtimeOrdinalSeen, runtimeOrdinal);
                return { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" };
              },
              protocolEvents,
              wrapCancel: (cancel) =>
                Effect.sync(() => {
                  cancelCalled = true;
                }).pipe(Effect.andThen(cancel)),
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
        });
        const threadId = ThreadId.make("thread-acp-settled-soft-steer");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-settled-soft-steer"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        // The still-running subagent defers finalize after session/prompt returns,
        // so the interrupt below hits a settled turn held open for background work.
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes('"stopReason"'),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });
        const interruptFiber = yield* runtime
          .interruptTurn({ providerThread, providerTurnId: firstProviderTurnId })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);
        assert.isFalse(
          cancelCalled,
          "settled soft steer must not send session/cancel (the real Grok CLI kills background subagents on cancel)",
        );

        let subagentTurnItemId: string | null = null;
        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentTurnItemId = event.turnItem.id;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.notEqual(subagentTurnItemId, null);

        subagentPhase = "complete";
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        // Same runtime process (mock-session-1): a respawn would start
        // mock-session-2 and drop the carryover on the session mismatch.
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:2",
        });
        let carriedItemStatus: string | null = null;
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.id === subagentTurnItemId
          ) {
            carriedItemStatus = event.turnItem.status;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(carriedItemStatus, "completed");
        assert.equal(secondTerminalStatus, "completed");
        assert.equal(
          runtimeOrdinalSeen,
          1,
          "settled soft steer must not respawn the ACP runtime process",
        );
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("preserveRuntimeOnSettledInterrupt does not soften a mid-prompt steering interrupt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          // Local hard-flavor gate: production Grok no longer sets
          // restartRuntimeOnEveryInterrupt, but when a flavor does, the
          // settled-soft gate must not leak onto an unsettled prompt.
          restartRuntimeOnEveryInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          preserveRuntimeOnSettledInterrupt: true,
          // No ownDetachedProcessGroup: the expected hard path fails loudly
          // on the missing terminateProcessGroup, proving the settled-soft
          // gate did not apply to an unsettled prompt.
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-unsettled-steer-stays-hard");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-unsettled-steer-stays-hard",
        ),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      const interruptExit = yield* runtime
        .interruptTurn({ providerThread, providerTurnId })
        .pipe(Effect.exit);
      if (Exit.isSuccess(interruptExit)) {
        assert.fail("mid-prompt steering interrupt must still take the hard teardown path");
      }
      assert.include(Cause.pretty(interruptExit.cause), "session is poisoned");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live(
    "soft mid-prompt interrupt cancels in place, reuses the runtime, and tracks cancel-backgrounded work",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const continuationRequests: Array<ProviderContinuationRequest> = [];
        const instanceId = ProviderInstanceId.make("acp-test");
        let cancelCalled = false;
        let runtimeOrdinalSeen = 0;
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            // Production Grok interrupt flags: hard teardown only with
            // requestRuntimeRestart (user Stop). Without
            // restartRuntimeOnEveryInterrupt a mid-prompt steering interrupt
            // stays soft: session/cancel, same process, session reuse.
            restartRuntimeAfterInterrupt: true,
            terminateRuntimeProcessGroupOnInterrupt: true,
            preserveRuntimeOnSettledInterrupt: true,
            registerExtensions: ({ runtime: extensionRuntime, applyBackgroundTaskMutation }) =>
              registerXAiBackgroundTaskTracking(extensionRuntime, applyBackgroundTaskMutation),
            // No ownDetachedProcessGroup: if the interrupt wrongly takes the
            // hard path, terminateProcessGroup is missing and the interrupt
            // fails loudly with a poisoned session.
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: (runtimeOrdinal) => {
                runtimeOrdinalSeen = Math.max(runtimeOrdinalSeen, runtimeOrdinal);
                return {
                  T3_ACP_EMIT_RUNNING_COMMAND_THEN_HANG_FIRST_PROMPT: "1",
                  T3_ACP_EMIT_TASK_BACKGROUNDED_AFTER_CANCEL: "1",
                };
              },
              protocolEvents,
              wrapCancel: (cancel) =>
                Effect.sync(() => {
                  cancelCalled = true;
                }).pipe(Effect.andThen(cancel)),
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-soft-mid-prompt-steer");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-soft-mid-prompt-steer"),
          modelSelection,
          runtimePolicy,
        });
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die(
            "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
          );
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime
          .startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
          )
          .pipe(Effect.forkScoped);
        // Wait for the running command tool so the interrupt lands mid-prompt.
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes("tool-call-running-1"),
          ),
          Stream.runHead,
        );

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });
        // No requestRuntimeRestart: a steering interrupt, not a user Stop.
        yield* runtime.interruptTurn({ providerThread, providerTurnId: firstProviderTurnId });
        assert.isTrue(
          cancelCalled,
          "soft mid-prompt interrupt must send session/cancel to detach the running work",
        );

        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        // The cancel handler emitted _x.ai/task_backgrounded for the detached
        // command; the tracked task must report as pending background work.
        let backgroundTracked = false;
        for (let attempt = 0; attempt < 80 && !backgroundTracked; attempt += 1) {
          backgroundTracked = yield* hasPendingBackgroundWork;
          if (!backgroundTracked) {
            yield* Effect.sleep("25 millis");
          }
        }
        assert.isTrue(
          backgroundTracked,
          "cancel-backgrounded task must be tracked as running background work",
        );

        // The second prompt reuses the same process and session.
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:2",
        });
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(secondTerminalStatus, "completed");
        assert.equal(
          runtimeOrdinalSeen,
          1,
          "soft mid-prompt interrupt must not respawn the ACP runtime process",
        );

        // _x.ai/task_completed lands ~1.2s after the cancel and clears the
        // tracked task without opening a synthetic continuation run.
        let backgroundPending = true;
        for (let attempt = 0; attempt < 50 && backgroundPending; attempt += 1) {
          backgroundPending = yield* hasPendingBackgroundWork;
          if (backgroundPending) {
            yield* Effect.sleep("100 millis");
          }
        }
        assert.isFalse(
          backgroundPending,
          "tracked background task must clear after _x.ai/task_completed",
        );
        assert.lengthOf(
          continuationRequests,
          0,
          "a cancel-backgrounded task completion must not wake a synthetic continuation run",
        );
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("direct Stop quarantine drops late background task mutations from the stopped run", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const capturedMutation: {
        current:
          | ((mutation: {
              readonly sessionId: string;
              readonly taskId: string;
              readonly status: "running" | "completed" | "failed";
            }) => Effect.Effect<void>)
          | null;
      } = { current: null };
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          preserveRuntimeOnSettledInterrupt: true,
          registerExtensions: (context) =>
            Effect.sync(() => {
              capturedMutation.current = context.applyBackgroundTaskMutation;
            }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            ownDetachedProcessGroup: true,
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-stop-quarantine-late-task");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-stop-quarantine-late-task"),
        modelSelection,
        runtimePolicy,
      });
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die(
          "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
        );
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const applyMutation = capturedMutation.current;
      if (applyMutation === null) {
        return yield* Effect.die("registerExtensions must capture applyBackgroundTaskMutation");
      }
      // Plumbing sanity: pre-Stop mutations on the root session track and
      // clear pending background work through the extension callback.
      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-pre-stop",
        status: "running",
      });
      assert.isTrue(
        yield* hasPendingBackgroundWork,
        "a running background task mutation on the root session must track before Stop",
      );
      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-pre-stop",
        status: "completed",
      });
      assert.isFalse(
        yield* hasPendingBackgroundWork,
        "a completed background task mutation must clear pending background work",
      );

      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true });
      let terminalStatus: string | null = null;
      while (terminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminalStatus = event.status;
        }
      }
      assert.equal(terminalStatus, "interrupted");

      // Residual lifecycle from the stopped run: activeSessionId still points
      // at the stopped session until the next turn respawns the runtime, so
      // only the direct Stop quarantine stands between this mutation and the
      // wake machinery.
      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-late-after-stop",
        status: "running",
      });
      assert.isFalse(
        yield* hasPendingBackgroundWork,
        "direct Stop quarantine must drop residual background task mutations from the stopped run",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("production Grok interrupt flags still hard-kill and respawn on user Stop", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      let runtimeOrdinalSeen = 0;
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          // The full production Grok interrupt flag set after the non-Stop
          // softening: no restartRuntimeOnEveryInterrupt. User Stop
          // (requestRuntimeRestart) must still take the hard teardown and
          // respawn path, not the soft cancel path.
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          preserveRuntimeOnSettledInterrupt: true,
          registerExtensions: ({ runtime: extensionRuntime, applyBackgroundTaskMutation }) =>
            registerXAiBackgroundTaskTracking(extensionRuntime, applyBackgroundTaskMutation),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            // Only hang the interrupted first turn. The replacement process must
            // complete normally so startTurn / session-load assertions can finish.
            environment: (runtimeOrdinal) => {
              runtimeOrdinalSeen = Math.max(runtimeOrdinalSeen, runtimeOrdinal);
              return runtimeOrdinal === 1 ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {};
            },
            ownDetachedProcessGroup: true,
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-production-stop-hard-kill");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-production-stop-hard-kill"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true });
      let terminalStatus: string | null = null;
      while (terminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminalStatus = event.status;
        }
      }
      assert.equal(terminalStatus, "interrupted");

      // Effect 4 Queue.takeAll waits for at least one element when empty. After
      // the session/prompt stream drain the protocol queue is often empty, so
      // takeAll would hang forever. Use clear (non-blocking drain) instead so
      // the session/load wait cannot match residual pre-restart traffic.
      yield* Queue.clear(protocolEvents);
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
      );
      const loadAfterRestart = yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) => event.direction === "outgoing" && rawProtocolMethod(event) === "session/load",
        ),
        Stream.runHead,
      );
      assert.isTrue(
        Option.isSome(loadAfterRestart),
        "user Stop must respawn the runtime and reload the session on the next turn",
      );
      assert.equal(
        runtimeOrdinalSeen,
        2,
        "user Stop with production Grok flags must replace the ACP runtime process",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  // it.live: ownDetachedProcessGroup teardown uses wall-clock sleeps; under
  // it.effect the interrupt timeout on context.completed still needs real time
  // after the soft steer clears the turn.
  it.live(
    "Stop after settled soft steer contains the orphan runtime and respawns without subagent carryover",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        let cancelCalled = false;
        let runtimeOrdinalSeen = 0;
        const childSessionId = "mock-child-session-1";
        const streamedSubagentText = "streamed subagent carryover text";
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            // Production Grok interrupt flags: soft settle keeps the process;
            // only requestRuntimeRestart (user Stop) hard-kills.
            restartRuntimeAfterInterrupt: true,
            terminateRuntimeProcessGroupOnInterrupt: true,
            preserveRuntimeOnSettledInterrupt: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: (runtimeOrdinal) => {
                runtimeOrdinalSeen = Math.max(runtimeOrdinalSeen, runtimeOrdinal);
                return { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" };
              },
              ownDetachedProcessGroup: true,
              protocolEvents,
              wrapCancel: (cancel) =>
                Effect.sync(() => {
                  cancelCalled = true;
                }).pipe(Effect.andThen(cancel)),
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              }),
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
        });
        const threadId = ThreadId.make("thread-acp-stop-after-soft-steer-orphan");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-stop-after-soft-steer-orphan",
          ),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes('"stopReason"'),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        // Stream assistant text onto the carryover subagent while the deferred
        // turn is still active so assistantText races ahead of task.result.
        assert.isDefined(sessionUpdateHandler, "session update handler must be wired");
        yield* sessionUpdateHandler!({
          sessionId: childSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: streamedSubagentText },
          },
        });
        let subagentTurnItemId: string | null = null;
        let streamedTextSeen = false;
        for (let attempt = 0; attempt < 64; attempt += 1) {
          const maybeEvent = yield* Queue.take(events).pipe(Effect.timeoutOption("50 millis"));
          if (Option.isNone(maybeEvent)) break;
          const event = maybeEvent.value;
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentTurnItemId = event.turnItem.id;
          }
          if (
            event.type === "message.updated" &&
            event.message.text.includes(streamedSubagentText)
          ) {
            streamedTextSeen = true;
            break;
          }
        }
        assert.isTrue(
          streamedTextSeen,
          "pre-steer child session chunk must project as subagent assistant text",
        );

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });
        // Soft steer first: clears the turn, leaves the process alive.
        yield* runtime.interruptTurn({ providerThread, providerTurnId: firstProviderTurnId });
        assert.isFalse(
          cancelCalled,
          "settled soft steer must not send session/cancel before the later Stop",
        );

        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentTurnItemId = event.turnItem.id;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.notEqual(subagentTurnItemId, null);
        assert.equal(
          runtimeOrdinalSeen,
          1,
          "soft steer must leave the original ACP runtime process alive",
        );

        // User Stop against the already-cleared turn: contain the orphan runtime.
        const stopExit = yield* runtime
          .interruptTurn({
            providerThread,
            providerTurnId: firstProviderTurnId,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.exit);
        if (Exit.isFailure(stopExit)) {
          assert.fail(
            `cleared-turn Stop must contain the orphan runtime, not fail: ${Cause.pretty(stopExit.cause)}`,
          );
        }

        // Orphan Stop must terminalize carried-over subagents (soft steer left them
        // running on purpose; quarantine alone would leave them stuck "running").
        let subagentStopStatus: string | null = null;
        let subagentStopResult: string | null | undefined;
        let subagentStopProviderThreadId: string | null | undefined;
        let subagentUpdatedResult: string | null | undefined;
        for (let attempt = 0; attempt < 64; attempt += 1) {
          const maybeEvent = yield* Queue.take(events).pipe(Effect.timeoutOption("50 millis"));
          if (Option.isNone(maybeEvent)) break;
          const event = maybeEvent.value;
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.id === subagentTurnItemId
          ) {
            subagentStopStatus = event.turnItem.status;
            subagentStopResult = event.turnItem.result;
            subagentStopProviderThreadId = event.turnItem.providerThreadId;
            if (subagentStopStatus === "interrupted") break;
          }
          if (
            event.type === "subagent.updated" &&
            event.subagent.status === "interrupted" &&
            event.subagent.result === streamedSubagentText
          ) {
            subagentUpdatedResult = event.subagent.result;
          }
        }
        assert.equal(
          subagentStopStatus,
          "interrupted",
          "orphan Stop must emit interrupted terminal for turn-1 carryover subagent",
        );
        assert.equal(
          subagentStopResult,
          streamedSubagentText,
          "orphan Stop must merge streamed assistantText into the interrupted result",
        );
        assert.equal(
          subagentStopProviderThreadId,
          providerThread.id,
          "orphan Stop parent-level events must use the spawn-time parent provider thread id",
        );
        assert.equal(
          subagentUpdatedResult,
          streamedSubagentText,
          "orphan Stop subagent.updated must also carry the streamed result",
        );

        yield* Queue.clear(protocolEvents);
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const loadAfterRestart = yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "outgoing" &&
              (rawProtocolMethod(event) === "session/load" ||
                rawProtocolMethod(event) === "session/new"),
          ),
          Stream.runHead,
        );
        assert.isTrue(
          Option.isSome(loadAfterRestart),
          "orphan containment must force a runtime respawn before the next turn",
        );
        assert.equal(
          runtimeOrdinalSeen,
          2,
          "Stop after soft steer must replace the orphan ACP runtime process",
        );

        // nativeTurnId is `${sessionId}:turn:${ordinal}`. The mock always uses
        // mock-session-1; ordinal 2 yields turn:2 on the replacement process.
        // Carryover was quarantined by Stop, so turn-1's subagent must not re-attach.
        subagentPhase = "complete";
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:2",
        });
        let carriedItemStatus: string | null = null;
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.id === subagentTurnItemId
          ) {
            carriedItemStatus = event.turnItem.status;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.isNull(
          carriedItemStatus,
          "Stop quarantine must drop turn-1 subagent carryover on the respawned runtime",
        );
        assert.equal(secondTerminalStatus, "completed");
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "settled soft interrupt skips cancel when prompt wire is settled before completion callback",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        let cancelCalled = false;
        const promptPhases: Array<string> = [];
        // Gate adapter-visible prompt return so we can open the race window after
        // the native stopReason is on the wire. Release lets Effect.tap mark
        // promptWireSettled before the completion callback requests the permit;
        // interrupt then ORs wire-done with promptSettled under the permit.
        const promptWireReturned = yield* Deferred.make<void>();
        const releasePromptCompletion = yield* Deferred.make<void>();
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            // Production Grok flags: without settled-soft, a steer soft-cancels.
            restartRuntimeAfterInterrupt: true,
            terminateRuntimeProcessGroupOnInterrupt: true,
            preserveRuntimeOnSettledInterrupt: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
              protocolEvents,
              wrapCancel: (cancel) =>
                Effect.sync(() => {
                  cancelCalled = true;
                }).pipe(Effect.andThen(cancel)),
              wrapRuntime: (runtime) => ({
                ...runtime,
                prompt: (payload) =>
                  Effect.gen(function* () {
                    promptPhases.push("prompt-start");
                    const result = yield* runtime.prompt(payload);
                    promptPhases.push("wire-returned");
                    yield* Deferred.succeed(promptWireReturned, undefined);
                    yield* Deferred.await(releasePromptCompletion);
                    promptPhases.push("completion-released");
                    return result;
                  }),
              }),
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
        });
        const threadId = ThreadId.make("thread-acp-settled-soft-admission-race");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-settled-soft-admission-race",
          ),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Deferred.await(promptWireReturned);
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes('"stopReason"'),
          ),
          Stream.runHead,
        );
        assert.deepEqual(promptPhases, ["prompt-start", "wire-returned"]);

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });
        // Fork interrupt while the adapter-side return is still gated. Release so
        // promptWireSettled completes (Effect.tap) before/while the completion
        // callback contends for runtimeCallbackPermit. Holding the gate forever
        // would also block the wire signal (same Effect resolution), so release
        // is required; the assertion is cancel skipped after that race window.
        const interruptFiber = yield* runtime
          .interruptTurn({ providerThread, providerTurnId: firstProviderTurnId })
          .pipe(Effect.forkScoped);
        yield* Deferred.succeed(releasePromptCompletion, undefined);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (promptPhases.includes("completion-released")) break;
          yield* Effect.yieldNow;
        }
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        assert.includeMembers(promptPhases, [
          "prompt-start",
          "wire-returned",
          "completion-released",
        ]);
        assert.isFalse(
          cancelCalled,
          "settled soft steer must skip session/cancel once the prompt wire has settled",
        );

        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.equal(subagentPhase, "spawn");
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "does not pin hasPendingBackgroundWork when a late TaskOutput re-reports an in-turn-handled task",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const continuationRequests: Array<ProviderContinuationRequest> = [];
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            extractBackgroundTaskId: (toolCall) =>
              toolCall.toolCallId === "tool-call-monitor-1" ? "task-monitor-1" : undefined,
            extractBackgroundTaskCompletion: (toolCall) =>
              toolCall.toolCallId === "tool-call-fetch-1"
                ? [
                    {
                      taskId: "task-monitor-1",
                      status: toolCall.status === "completed" ? "completed" : "running",
                      appendOutput: toolCall.status === "completed" ? "MONITOR_LISTING_TOKEN" : "",
                    },
                  ]
                : [],
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: {
                T3_ACP_EMIT_IN_TURN_TASKOUTPUT_THEN_LATE_DUPLICATE: "1",
              },
              protocolEvents,
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-already-handled-wake-pin");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-already-handled-wake-pin",
          ),
          modelSelection,
          runtimePolicy,
        });
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die(
            "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
          );
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });

        let terminalStatus: string | null = null;
        while (terminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
            terminalStatus = event.status;
          }
        }
        assert.equal(terminalStatus, "completed");

        // Wait for the late post-finalize duplicate TaskOutput frame.
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes("MONITOR_LISTING_TOKEN_LATE"),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.lengthOf(
          continuationRequests,
          0,
          "already-handled late TaskOutput must not open a continuation run",
        );
        assert.isFalse(
          yield* hasPendingBackgroundWork,
          "wake buffer must not stay non-empty and pin idle release after an already-handled re-report",
        );
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "keeps a dispatched continuation offer sticky until a turn starts or the worker drops it",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const continuationRequests: Array<ProviderContinuationRequest> = [];
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              }),
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-sticky-continuation-dispatch");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-sticky-continuation-dispatch",
          ),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });
        let terminalStatus: string | null = null;
        while (terminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
            terminalStatus = event.status;
          }
        }
        assert.equal(terminalStatus, "completed");
        assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

        const lateTool = (toolCallId: string) =>
          sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              title: "Late tool result",
              kind: "other",
              status: "completed",
              rawOutput: { output: toolCallId },
            },
          });
        yield* lateTool("first-late-result");
        assert.lengthOf(continuationRequests, 1);
        const first = continuationRequests[0]!;
        assert.isDefined(first.dispatchIfCurrent);
        assert.isTrue(Option.isSome(yield* first.dispatchIfCurrent!(Effect.void)));

        yield* lateTool("second-frame-before-dispatched-turn-starts");
        assert.lengthOf(
          continuationRequests,
          1,
          "late frames must not enqueue duplicate continuations during dispatch-to-start",
        );

        assert.isDefined(first.clearIfCurrent);
        yield* first.clearIfCurrent!();
        yield* lateTool("new-result-after-worker-drop");
        assert.lengthOf(continuationRequests, 2);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "holds a settled turn until the injected monitor report streams instead of finalizing into it",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const triggerDir = yield* fileSystem.makeTempDirectoryScoped();
        const triggerPath = path.join(triggerDir, "report-trigger");
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            extractBackgroundTaskId: (toolCall) =>
              toolCall.toolCallId === "tool-call-monitor-1" ? "task-monitor-1" : undefined,
            extractBackgroundToolMutation: (text) =>
              text.includes('Monitor "task-monitor-1" ended')
                ? [{ taskId: "task-monitor-1", status: "completed", appendOutput: "" }]
                : [],
            extractBackgroundTaskCompletion: (toolCall) =>
              toolCall.toolCallId === "tool-call-fetch-1"
                ? [
                    {
                      taskId: "task-monitor-1",
                      status: toolCall.status === "completed" ? "completed" : "running",
                      appendOutput: toolCall.status === "completed" ? "MONITOR_LISTING_TOKEN" : "",
                    },
                  ]
                : [],
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: {
                T3_ACP_EMIT_POST_SETTLE_MONITOR_FLOW: "1",
                T3_ACP_INJECTED_REPORT_TRIGGER_PATH: triggerPath,
              },
              protocolEvents,
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
        });
        const threadId = ThreadId.make("thread-acp-injected-report-hold");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-injected-report"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });

        // Wait (real time) until the post-settle end notice and TaskOutput
        // hydration are ingested: the hydrated monitor card carries the
        // fetched listing.
        let reportSeen = false;
        const trackReport = (event: ProviderAdapterV2Event): void => {
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text.includes("MONITOR_REPORT_TOKEN")
          ) {
            reportSeen = true;
          }
        };
        let hydrated = false;
        while (!hydrated) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "completed" &&
            (event.turnItem.output ?? "").includes("MONITOR_LISTING_TOKEN")
          ) {
            hydrated = true;
          }
        }
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        // Pre-fix the 2s deferred-finalize debounce fires here and the report
        // streamed by the injected turn afterwards is dropped on the floor.
        yield* TestClock.adjust("3 seconds");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        let drained = yield* Queue.poll(events);
        while (Option.isSome(drained)) {
          trackReport(drained.value);
          assert.notEqual(
            drained.value.type,
            "turn.terminal",
            "deferred finalize must hold while the injected-turn report is owed",
          );
          drained = yield* Queue.poll(events);
        }

        // Release the report, then the normal debounce finalizes the turn.
        yield* fileSystem.writeFileString(triggerPath, "go");
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes("MONITOR_REPORT_TOKEN"),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        let terminalStatus: string | null = null;
        while (terminalStatus === null) {
          const event = yield* Queue.take(events);
          trackReport(event);
          if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
            terminalStatus = event.status;
          }
        }
        assert.equal(terminalStatus, "completed");
        assert.isTrue(
          reportSeen,
          "the injected-turn report must project before the turn finalizes",
        );
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("restarts the ACP child process before the next prompt after interrupt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-restart-after-interrupt");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-restart-after-interrupt"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
      );
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: `${providerThread.nativeThreadRef?.nativeId}:turn:1`,
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/cancel",
        ),
        Stream.runHead,
      );

      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
      );
      const loadAfterRestart = yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) => event.direction === "outgoing" && rawProtocolMethod(event) === "session/load",
        ),
        Stream.runHead,
      );
      assert.isTrue(
        Option.isSome(loadAfterRestart),
        "post-interrupt startTurn should respawn the runtime and replay session/load",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("Windows teardown is one-shot explicitly with independent finalizer cleanup", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const runtimeScope = yield* Scope.make();
      const taskkillCommands: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      }> = [];
      const taskkillSpawner = makeTaskkillSpawner({ exitCode: 0, commands: taskkillCommands });
      const spawner = ChildProcessSpawner.make((command) => {
        const value = command as unknown as { readonly command: string };
        return value.command === "taskkill"
          ? taskkillSpawner.spawn(command)
          : childProcessSpawner.spawn(command);
      });
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: process.cwd(),
            env: { T3_ACP_SESSION_LIFECYCLE: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-acp-test", version: "0.0.0" },
          ownDetachedProcessGroup: true,
          processGroupPlatform: "win32",
        }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
      ).pipe(Effect.provideService(Scope.Scope, runtimeScope));
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      assert.isDefined(runtime.terminateProcessGroup);
      yield* Effect.all([runtime.terminateProcessGroup!, runtime.terminateProcessGroup!], {
        concurrency: "unbounded",
      });
      assert.equal(taskkillCommands.length, 1);
      yield* Scope.close(runtimeScope, Exit.void);
      assert.equal(taskkillCommands.length, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it("accepts only taskkill exit code zero as successful tree termination", () => {
    assert.isTrue(AcpSessionRuntime.windowsTaskkillResultIsSuccess(0, ""));
    assert.isFalse(
      AcpSessionRuntime.windowsTaskkillResultIsSuccess(
        128,
        "FEHLER: Der Prozess wurde nicht gefunden.",
      ),
    );
    assert.isFalse(AcpSessionRuntime.windowsTaskkillResultIsSuccess(128, ""));
    assert.isFalse(AcpSessionRuntime.windowsTaskkillResultIsSuccess(1, "localized failure"));
    assert.isFalse(AcpSessionRuntime.windowsTaskkillResultIsSuccess(255, ""));
  });

  it.effect("runs the default taskkill path and preserves every failure mode", () =>
    Effect.gen(function* () {
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];
      yield* AcpSessionRuntime.terminateWindowsProcessTreeWithTaskkill(
        makeTaskkillSpawner({ exitCode: 0, commands }),
        4321,
      );
      assert.deepEqual(commands, [{ command: "taskkill", args: ["/PID", "4321", "/T", "/F"] }]);

      for (const fixture of [
        { exitCode: 128, output: 'ERROR: The process "4321" not found.' },
        { exitCode: 128, output: "FEHLER: Prozess nicht gefunden." },
        { exitCode: 128, output: "" },
        { exitCode: 128, output: "ERROR: Access is denied." },
        { exitCode: 1, output: "generic failure" },
      ]) {
        const failed = yield* AcpSessionRuntime.terminateWindowsProcessTreeWithTaskkill(
          makeTaskkillSpawner(fixture),
          4321,
        ).pipe(Effect.exit);
        if (Exit.isSuccess(failed)) assert.fail(`taskkill ${fixture.exitCode} must fail`);
        const error = Cause.squash(failed.cause);
        assert.instanceOf(error, AcpSessionRuntime.AcpProcessGroupTerminationError);
        const termination = error as AcpSessionRuntime.AcpProcessGroupTerminationError;
        assert.equal(
          termination.detail,
          `taskkill exited ${fixture.exitCode} for ACP process tree 4321`,
        );
        assert.equal(termination.pid, 4321);
        assert.equal(termination.exitCode, fixture.exitCode);
        if (fixture.output.length > 0) {
          assert.equal(termination.cause, fixture.output);
        }
      }

      for (const fixture of [
        { spawnFailure: true },
        { outputFailure: true },
        { exitFailure: true },
      ]) {
        const failed = yield* AcpSessionRuntime.terminateWindowsProcessTreeWithTaskkill(
          makeTaskkillSpawner(fixture),
          4321,
        ).pipe(Effect.exit);
        if (Exit.isSuccess(failed)) assert.fail("taskkill infrastructure failure must fail");
        const error = Cause.squash(failed.cause);
        assert.instanceOf(error, AcpSessionRuntime.AcpProcessGroupTerminationError);
        assert.equal(
          (error as AcpSessionRuntime.AcpProcessGroupTerminationError).detail,
          "Failed to run taskkill for ACP process tree 4321",
        );
      }
    }),
  );

  it.effect("Windows process-tree teardown surfaces taskkill failure", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: { command: process.execPath, args: [mockAgentPath], cwd: process.cwd() },
          cwd: process.cwd(),
          clientInfo: { name: "t3-acp-test", version: "0.0.0" },
          ownDetachedProcessGroup: true,
          processGroupPlatform: "win32",
          windowsProcessTreeTerminator: () =>
            Effect.fail(
              new AcpSessionRuntime.AcpProcessGroupTerminationError({
                detail: "mock taskkill failure",
              }),
            ),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const error = yield* Effect.flip(runtime.terminateProcessGroup!);
      assert.equal(error.detail, "mock taskkill failure");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("poisons the session when hard teardown defects and blocks replacement work", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const commandPidPath = yield* fileSystem.makeTempFileScoped({
        prefix: "t3-acp-failed-teardown-command-",
      });
      const residualCallbackDir = yield* fileSystem.makeTempDirectoryScoped();
      const residualCallbackResponseLogPath = path.join(residualCallbackDir, "responses.log");
      const residualCallbackTriggerPath = path.join(residualCallbackDir, "trigger");
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const continuationRequests: Array<ProviderContinuationRequest> = [];
      const teardownStarted = yield* Deferred.make<void>();
      const releaseTeardown = yield* Deferred.make<void>();
      let terminatorCallCount = 0;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: () =>
              Effect.gen(function* () {
                terminatorCallCount += 1;
                yield* Deferred.succeed(teardownStarted, undefined);
                yield* Deferred.await(releaseTeardown);
                return yield* Effect.die("mock taskkill defect");
              }),
            environment: {
              T3_ACP_EMIT_RUNNING_COMMAND_THEN_HANG: "1",
              T3_ACP_RESIDUAL_CALLBACK_RESPONSE_LOG_PATH: residualCallbackResponseLogPath,
              T3_ACP_RESIDUAL_CALLBACK_TRIGGER_PATH: residualCallbackTriggerPath,
              T3_ACP_RUNNING_COMMAND_PID_PATH: commandPidPath,
            },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-failed-hard-teardown");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-failed-hard-teardown"),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      const adapterEvents = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(adapterEvents, event)),
        Effect.forkIn(sessionScope),
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      while ((yield* fileSystem.readFileString(commandPidPath)).trim().length === 0) {
        yield* Effect.yieldNow;
      }
      const [commandRootPid, commandSleepPid] = (yield* fileSystem.readFileString(commandPidPath))
        .trim()
        .split(/\s+/)
        .map(Number);
      assert.isTrue(
        Option.isSome(yield* waitForProcesses([commandRootPid!, commandSleepPid!])),
        "declared failed-teardown Bash and sleep PIDs must both become live",
      );
      yield* pollProtocolMethods(protocolEvents);

      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(teardownStarted);
      const startFiber = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isUndefined(startFiber.pollUnsafe());
      const methodsDuringTeardown = yield* pollProtocolMethods(protocolEvents);
      yield* Deferred.succeed(releaseTeardown, undefined);
      assert.notInclude(methodsDuringTeardown, "session/load");
      assert.notInclude(methodsDuringTeardown, "session/prompt");

      const interruptExit = yield* Fiber.join(interruptFiber);
      if (Exit.isSuccess(interruptExit)) assert.fail("hard teardown failure must fail interrupt");
      assert.include(Cause.pretty(interruptExit.cause), "session is poisoned");
      assert.isTrue(
        Option.isSome(yield* waitForProcesses([commandRootPid!, commandSleepPid!])),
        "failed teardown must leave both declared Bash and sleep PIDs live",
      );

      while (Option.isSome(yield* Queue.poll(adapterEvents))) {
        // Discard the interrupted turn's expected projection before residual traffic.
      }
      yield* fileSystem.writeFileString(residualCallbackTriggerPath, "go");
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "raw" &&
            typeof event.payload === "string" &&
            event.payload.includes('"method":"session/elicitation"'),
        ),
        Stream.runHead,
      );
      yield* Effect.sleep("100 millis");
      assert.isTrue(
        Option.isNone(yield* Queue.poll(adapterEvents)),
        "residual callbacks must not mutate or emit adapter projection after poison",
      );
      assert.isFalse(
        yield* fileSystem.exists(residualCallbackResponseLogPath),
        "permission and elicitation callbacks must remain unresolved after poison",
      );
      assert.lengthOf(
        continuationRequests,
        0,
        "residual callbacks must not offer a continuation after poison",
      );

      const startExit = yield* Fiber.join(startFiber);
      if (Exit.isSuccess(startExit)) assert.fail("poisoned session must reject startTurn");
      assert.include(Cause.pretty(startExit.cause), "session is poisoned");
      const resumeExit = yield* runtime
        .resumeThread({ providerThread, modelSelection, runtimePolicy })
        .pipe(Effect.exit);
      if (Exit.isSuccess(resumeExit)) assert.fail("poisoned session must reject resumeThread");
      assert.include(Cause.pretty(resumeExit.cause), "session is poisoned");
      const snapshotExit = yield* runtime.readThreadSnapshot({ providerThread }).pipe(Effect.exit);
      if (Exit.isSuccess(snapshotExit)) {
        assert.fail("poisoned session must reject readThreadSnapshot");
      }
      assert.include(Cause.pretty(snapshotExit.cause), "session is poisoned");
      const forkExit = yield* runtime
        .forkThread({
          sourceProviderThread: providerThread,
          targetThreadId: ThreadId.make("thread-acp-poisoned-fork"),
        })
        .pipe(Effect.exit);
      if (Exit.isSuccess(forkExit)) assert.fail("poisoned session must reject forkThread");
      assert.include(Cause.pretty(forkExit.cause), "session is poisoned");
      yield* pollProtocolMethods(protocolEvents);
      const retryInterruptExit = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.exit);
      if (Exit.isSuccess(retryInterruptExit)) {
        assert.fail("poisoned session must reject a repeated hard interrupt");
      }
      const firstInterruptError = Cause.squash(interruptExit.cause) as Error;
      const retryInterruptError = Cause.squash(retryInterruptExit.cause) as Error;
      assert.strictEqual(retryInterruptError.cause, firstInterruptError.cause);
      assert.equal(terminatorCallCount, 1);
      const methodsAfterPoison = yield* pollProtocolMethods(protocolEvents);
      assert.notInclude(methodsAfterPoison, "initialize");
      assert.notInclude(methodsAfterPoison, "session/cancel");
      assert.notInclude(methodsAfterPoison, "session/fork");
      assert.notInclude(methodsAfterPoison, "session/load");
      assert.notInclude(methodsAfterPoison, "session/prompt");
      assert.isTrue(processExists(commandRootPid!));
      assert.isTrue(processExists(commandSleepPid!));
      yield* Scope.close(sessionScope, Exit.void);
      assert.isTrue(
        Option.isSome(yield* waitForProcessesToExit([commandRootPid!, commandSleepPid!])),
        "finalizer cleanup must reap both declared Bash and sleep PIDs",
      );
      assert.isFalse(processExists(commandRootPid!));
      assert.isFalse(processExists(commandSleepPid!));
      const finalizerMethods = yield* pollProtocolMethods(protocolEvents);
      assert.notInclude(finalizerMethods, "session/close");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("durably poisons start and resume when required hard teardown is unavailable", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-missing-hard-teardown");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-missing-hard-teardown"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      const interruptExit = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.exit);
      if (Exit.isSuccess(interruptExit)) assert.fail("missing hard teardown must fail interrupt");
      assert.include(Cause.pretty(interruptExit.cause), "session is poisoned");

      const startExit = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.exit);
      if (Exit.isSuccess(startExit)) assert.fail("poisoned session must reject startTurn");
      assert.include(Cause.pretty(startExit.cause), "session is poisoned");
      const resumeExit = yield* runtime
        .resumeThread({ providerThread, modelSelection, runtimePolicy })
        .pipe(Effect.exit);
      if (Exit.isSuccess(resumeExit)) assert.fail("poisoned session must reject resumeThread");
      assert.include(Cause.pretty(resumeExit.cause), "session is poisoned");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("holds concurrent startTurn behind successful hard teardown and reloads once", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const teardownStarted = yield* Deferred.make<void>();
      const releaseTeardown = yield* Deferred.make<void>();
      let runtimeOrdinalSeen = 0;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: () =>
              Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTeardown)),
              ),
            environment: (runtimeOrdinal) => {
              runtimeOrdinalSeen = runtimeOrdinal;
              return runtimeOrdinal === 1 ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {};
            },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-concurrent-hard-teardown");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-concurrent-hard-teardown"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      yield* pollProtocolMethods(protocolEvents);
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(teardownStarted);
      const startFiber = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isUndefined(startFiber.pollUnsafe());
      assert.equal(runtimeOrdinalSeen, 1);
      const methodsDuringTeardown = yield* pollProtocolMethods(protocolEvents);
      assert.notInclude(methodsDuringTeardown, "session/load");
      assert.notInclude(methodsDuringTeardown, "session/prompt");

      yield* Deferred.succeed(releaseTeardown, undefined);
      yield* Fiber.join(interruptFiber);
      yield* Fiber.join(startFiber);
      assert.equal(runtimeOrdinalSeen, 2);
      const replacementMethods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(replacementMethods.filter((method) => method === "session/load").length, 1);
      if (!replacementMethods.includes("session/prompt")) {
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
          ),
          Stream.runHead,
        );
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("quarantines old-runtime callbacks after successful hard teardown", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const continuationRequests: Array<ProviderContinuationRequest> = [];
      const responseLifecycle: Array<string> = [];
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      type HandlerRecord = {
        sessionUpdate?: Parameters<RuntimeService["handleSessionUpdate"]>[0];
        permission?: Parameters<RuntimeService["handleRequestPermission"]>[0];
        elicitation?: Parameters<RuntimeService["handleElicitation"]>[0];
        requestUserInput?: AcpAdapterV2ExtensionContext["requestUserInput"];
      };
      const handlerRecords: HandlerRecord[] = [];
      const runtimeInputs: AcpAdapterV2RuntimeInput[] = [];
      const oldPromptCompletion = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
      const transportDrained = yield* Deferred.make<void>();
      const releaseTransportDrain = yield* Deferred.make<void>();
      let extensionOrdinal = 0;
      let runtimeOrdinalSeen = 0;
      const instanceId = ProviderInstanceId.make("acp-test");
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        ownDetachedProcessGroup: true,
        processGroupPlatform: "win32",
        windowsProcessTreeTerminator: () => Effect.void,
        environment: (runtimeOrdinal) => {
          runtimeOrdinalSeen = runtimeOrdinal;
          return { T3_ACP_HANG_PROMPT_FOREVER: "1" };
        },
        protocolEvents,
        wrapRuntime: (runtime, runtimeOrdinal) => {
          const record: HandlerRecord = {};
          handlerRecords[runtimeOrdinal - 1] = record;
          return {
            ...runtime,
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                record.sessionUpdate = handler;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            handleRequestPermission: (handler) =>
              Effect.sync(() => {
                record.permission = handler;
              }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
            handleElicitation: (handler) =>
              Effect.sync(() => {
                record.elicitation = handler;
              }).pipe(Effect.andThen(runtime.handleElicitation(handler))),
            ...(runtimeOrdinal === 1
              ? {
                  prompt: (payload) =>
                    Effect.gen(function* () {
                      yield* runtime.prompt(payload).pipe(Effect.ignore, Effect.forkDetach);
                      return yield* Deferred.await(oldPromptCompletion);
                    }),
                }
              : {}),
          };
        },
      });
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          registerExtensions: ({ requestUserInput }) =>
            Effect.sync(() => {
              handlerRecords[extensionOrdinal++]!.requestUserInput = requestUserInput;
            }),
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => {
              runtimeInputs.push(runtimeInput);
            }).pipe(Effect.andThen(makeRuntime(runtimeInput))),
        },
        fileSystem,
        idAllocator,
        serverConfig,
        testHooks: {
          afterHardTeardownTransportDrained: () =>
            Deferred.succeed(transportDrained, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTransportDrain)),
            ),
          onNativeResponseLifecycle: (event) =>
            Effect.sync(() => {
              responseLifecycle.push(event.type);
            }),
        },
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-successful-teardown-callback-quarantine");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-successful-teardown-callback-quarantine",
        ),
        modelSelection,
        runtimePolicy,
      });
      const adapterEvents = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(adapterEvents, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      const permissionRequest = {
        sessionId: "mock-session-1",
        toolCall: {
          toolCallId: "stale-generation-1-permission",
          title: "Stale generation 1 permission",
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      };
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(transportDrained);
      const heldInboundFiber = yield* runtimeInputs[0]!.onIncomingRequest!(
        "post-drain-stale-permission-id",
        "session/request_permission",
        permissionRequest,
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(heldInboundFiber.pollUnsafe());
      yield* Deferred.succeed(releaseTransportDrain, undefined);
      yield* Fiber.join(heldInboundFiber);
      yield* Fiber.join(interruptFiber);
      assert.notInclude(responseLifecycle, "registered");
      assert.notInclude(responseLifecycle, "watcher_started");
      assert.isFalse(
        (yield* Queue.takeAll(adapterEvents)).some(
          (event) => event.type === "runtime_request.updated",
        ),
        "post-drain inbound callback must not emit a runtime request",
      );
      assert.equal(runtimeOrdinalSeen, 1);
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
      );
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      assert.equal(runtimeOrdinalSeen, 2);
      const oldHandlers = handlerRecords[0]!;
      const replacementHandlers = handlerRecords[1]!;
      assert.isDefined(oldHandlers.sessionUpdate);
      assert.isDefined(oldHandlers.permission);
      assert.isDefined(oldHandlers.elicitation);
      assert.isDefined(oldHandlers.requestUserInput);
      assert.isDefined(replacementHandlers.sessionUpdate);
      assert.isDefined(replacementHandlers.permission);
      assert.isDefined(replacementHandlers.elicitation);
      assert.isDefined(replacementHandlers.requestUserInput);
      assert.lengthOf(runtimeInputs, 2);
      while (Option.isSome(yield* Queue.poll(adapterEvents))) {
        // Discard generation 1 terminal and generation 2 startup projection.
      }

      yield* oldHandlers.sessionUpdate!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "stale generation 1 assistant" },
        },
      });
      yield* oldHandlers.sessionUpdate!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "stale-generation-1-tool",
          title: "Stale generation 1 tool",
          kind: "other",
          status: "completed",
          rawOutput: { output: "stale continuation evidence" },
        },
      });
      const oldPermissionFiber = yield* oldHandlers.permission!(permissionRequest).pipe(
        Effect.exit,
        Effect.forkScoped,
      );
      const oldElicitationFiber = yield* oldHandlers.elicitation!({
        sessionId: "mock-session-1",
        message: "Stale generation 1 elicitation",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { approved: { type: "boolean", title: "Approved" } },
        },
      }).pipe(Effect.exit, Effect.forkScoped);
      const oldXAiUserInputFiber = yield* oldHandlers.requestUserInput!({
        nativeItemId: "stale-generation-1-xai-item",
        nativeMethod: "_x.ai/ask_user_question",
        nativeRequestId: "stale-generation-1-xai-request",
        nativeSessionId: "mock-session-1",
        questions: [
          {
            id: "approved",
            header: "Approve",
            question: "Approve stale generation 1?",
            options: [{ label: "yes", description: "Approve" }],
          },
        ],
      }).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.succeed(oldPromptCompletion, { stopReason: "end_turn" });
      yield* Effect.sleep("100 millis");
      assert.isTrue(Option.isNone(yield* Queue.poll(adapterEvents)));
      assert.isUndefined(oldPermissionFiber.pollUnsafe());
      assert.isUndefined(oldElicitationFiber.pollUnsafe());
      assert.isUndefined(oldXAiUserInputFiber.pollUnsafe());
      assert.lengthOf(continuationRequests, 0);

      yield* replacementHandlers.sessionUpdate!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live generation 2 assistant" },
        },
      });
      let replacementMessageSeen = false;
      while (!replacementMessageSeen) {
        const event = yield* Queue.take(adapterEvents);
        replacementMessageSeen =
          event.type === "message.updated" && event.message.text.includes("live generation 2");
      }
      const missingPermissionTransport = yield* replacementHandlers.permission!(
        permissionRequest,
      ).pipe(Effect.exit);
      if (Exit.isSuccess(missingPermissionTransport)) {
        assert.fail("a core permission request without transport correlation must fail closed");
      }
      assert.include(Cause.pretty(missingPermissionTransport.cause), "Could not correlate");
      yield* runtimeInputs[1]!.onIncomingRequest!(
        "live-generation-2-permission-id",
        "session/request_permission",
        permissionRequest,
      );
      const replacementPermission = yield* replacementHandlers.permission!(permissionRequest);
      assert.equal(replacementPermission.outcome.outcome, "selected");
      yield* runtimeInputs[1]!.onOutgoingResponse!("live-generation-2-permission-id");
      const urlElicitation = {
        elicitationId: "replacement-url-id",
        message: "Open replacement URL",
        mode: "url" as const,
        sessionId: "mock-session-1",
        url: "https://example.com/replacement",
      };
      const missingElicitationTransport = yield* replacementHandlers.elicitation!(
        urlElicitation,
      ).pipe(Effect.exit);
      if (Exit.isSuccess(missingElicitationTransport)) {
        assert.fail("a core elicitation request without transport correlation must fail closed");
      }
      assert.include(Cause.pretty(missingElicitationTransport.cause), "Could not correlate");
      yield* runtimeInputs[1]!.onIncomingRequest!(
        "live-generation-2-url-id",
        "session/elicitation",
        urlElicitation,
      );
      yield* replacementHandlers.elicitation!(urlElicitation);
      yield* runtimeInputs[1]!.onOutgoingResponse!("live-generation-2-url-id");

      const collidingRequestPayload = {
        sessionId: "mock-session-1",
        toolCallId: "shared-request-id",
      };
      const missingXAiTransport = yield* replacementHandlers.requestUserInput!({
        nativeItemId: "missing-generation-2-xai-item",
        nativeMethod: "_x.ai/ask_user_question",
        nativeRequestId: "shared-request-id",
        nativeSessionId: "mock-session-1",
        questions: [
          {
            id: "approved",
            header: "Approve",
            question: "Approve missing transport?",
            options: [{ label: "yes", description: "Approve" }],
          },
        ],
      }).pipe(Effect.exit);
      if (Exit.isSuccess(missingXAiTransport)) {
        assert.fail("an xAI user input request without transport correlation must fail closed");
      }
      assert.include(Cause.pretty(missingXAiTransport.cause), "Could not correlate");
      yield* runtimeInputs[0]!.onIncomingRequest!(
        "stale-generation-1-transport-id",
        "x.ai/ask_user_question",
        collidingRequestPayload,
      );
      yield* runtimeInputs[1]!.onIncomingRequest!(
        "live-generation-2-wrong-method-id",
        "x.ai/ask_user_question",
        collidingRequestPayload,
      );
      yield* runtimeInputs[1]!.onIncomingRequest!(
        "live-generation-2-transport-id",
        "_x.ai/ask_user_question",
        collidingRequestPayload,
      );
      const replacementUserInputFiber = yield* replacementHandlers.requestUserInput!({
        nativeItemId: "live-generation-2-xai-item",
        nativeMethod: "_x.ai/ask_user_question",
        nativeRequestId: "shared-request-id",
        nativeSessionId: "mock-session-1",
        questions: [
          {
            id: "approved",
            header: "Approve",
            question: "Approve live generation 2?",
            options: [{ label: "yes", description: "Approve" }],
          },
        ],
      }).pipe(Effect.forkScoped);
      let replacementRequest: ProviderAdapterV2Event | undefined;
      while (replacementRequest === undefined) {
        const event = yield* Queue.take(adapterEvents);
        if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending") {
          replacementRequest = event;
        }
      }
      if (replacementRequest.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected generation 2 xAI user input request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({
          requestId: replacementRequest.runtimeRequest.id,
          answers: { approved: ["yes"] },
        })
        .pipe(Effect.forkScoped);
      const replacementUserInput = yield* Fiber.join(replacementUserInputFiber);
      assert.deepEqual(replacementUserInput.answers, { approved: ["yes"] });
      yield* replacementUserInput.acknowledgeNativeResponse;
      yield* runtimeInputs[0]!.onOutgoingResponse!("stale-generation-1-transport-id");
      yield* runtimeInputs[1]!.onOutgoingResponse!("live-generation-2-wrong-method-id");
      yield* Effect.yieldNow;
      assert.isUndefined(responseFiber.pollUnsafe());
      yield* runtimeInputs[1]!.onOutgoingResponse!("live-generation-2-transport-id");
      yield* Fiber.join(responseFiber);

      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:2",
        }),
        requestRuntimeRestart: true,
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("keeps stale deferred cleanup inert while replacement requests remain live", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: () => Effect.void,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-stale-deferred-cleanup");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-stale-deferred-cleanup"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
      );
      const oldPending = yield* Queue.take(events).pipe(
        Effect.repeat({
          until: (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        }),
      );
      if (
        oldPending.type !== "runtime_request.updated" ||
        oldPending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected the old runtime permission request");
      }
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: oldPending.runtimeRequest.providerTurnId,
        requestRuntimeRestart: true,
      });
      const staleResponse = yield* runtime
        .respondToRuntimeRequest({
          requestId: oldPending.runtimeRequest.id,
          decision: "accept",
        })
        .pipe(Effect.exit);
      if (Exit.isSuccess(staleResponse)) {
        assert.fail("teardown must synchronously remove the old pending request");
      }
      while (Option.isSome(yield* Queue.poll(events))) {
        // Discard generation 1 cancellation and terminal projection.
      }

      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
      );
      let replacementPending: ProviderAdapterV2Event | undefined;
      while (replacementPending === undefined) {
        const event = yield* Queue.take(events);
        if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending") {
          replacementPending = event;
        }
      }
      if (replacementPending.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected the replacement runtime permission request");
      }
      assert.notEqual(replacementPending.runtimeRequest.id, oldPending.runtimeRequest.id);
      yield* runtime.respondToRuntimeRequest({
        requestId: replacementPending.runtimeRequest.id,
        decision: "accept",
      });
      let replacementTerminal = false;
      while (!replacementTerminal) {
        const event = yield* Queue.take(events);
        if (
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.id === oldPending.runtimeRequest.id
        ) {
          assert.fail("stale deferred cleanup must not emit into generation 2");
        }
        replacementTerminal = event.type === "turn.terminal";
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("resolves owner cancellation and concurrent resume waiters after hard teardown", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const teardownStarted = yield* Deferred.make<void>();
      const releaseTeardown = yield* Deferred.make<void>();
      let runtimeOrdinalSeen = 0;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: () =>
              Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTeardown)),
              ),
            environment: (runtimeOrdinal) => {
              runtimeOrdinalSeen = runtimeOrdinal;
              return runtimeOrdinal === 1 ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {};
            },
            protocolEvents,
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-concurrent-resume-teardown");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-concurrent-resume-teardown",
        ),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* pollProtocolMethods(protocolEvents);
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(teardownStarted);
      const resumeFiber = yield* runtime
        .resumeThread({ providerThread, modelSelection, runtimePolicy })
        .pipe(Effect.forkScoped);
      const secondResumeFiber = yield* runtime
        .resumeThread({ providerThread, modelSelection, runtimePolicy })
        .pipe(Effect.forkScoped);
      const snapshotProviderThread = {
        ...providerThread,
        nativeThreadRef: {
          ...providerThread.nativeThreadRef!,
          nativeId: "mock-session-snapshot",
        },
      };
      const snapshotFiber = yield* runtime
        .readThreadSnapshot({ providerThread: snapshotProviderThread })
        .pipe(Effect.forkScoped);
      const forkFiber = yield* runtime
        .forkThread({
          sourceProviderThread: providerThread,
          targetThreadId: ThreadId.make("thread-acp-concurrent-fork-after-teardown"),
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isUndefined(resumeFiber.pollUnsafe());
      assert.isUndefined(secondResumeFiber.pollUnsafe());
      assert.isUndefined(snapshotFiber.pollUnsafe());
      assert.isUndefined(forkFiber.pollUnsafe());
      assert.equal(runtimeOrdinalSeen, 1);
      const methodsDuringTeardown = yield* pollProtocolMethods(protocolEvents);
      assert.notInclude(methodsDuringTeardown, "session/load");
      assert.notInclude(methodsDuringTeardown, "session/fork");
      const cancelInterruptOwner = yield* Fiber.interrupt(interruptFiber).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isUndefined(cancelInterruptOwner.pollUnsafe());
      yield* Deferred.succeed(releaseTeardown, undefined);
      yield* Fiber.join(cancelInterruptOwner);
      yield* Fiber.join(resumeFiber);
      yield* Fiber.join(secondResumeFiber);
      yield* Fiber.join(snapshotFiber);
      yield* Fiber.join(forkFiber);
      assert.equal(runtimeOrdinalSeen, 2);
      const methodsAfterRestart = yield* pollProtocolMethods(protocolEvents);
      assert.equal(methodsAfterRestart.filter((method) => method === "session/load").length, 2);
      assert.equal(methodsAfterRestart.filter((method) => method === "session/fork").length, 1);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("direct Stop skips uninterruptible ACP cancel and recovers after native teardown", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const commandPidPath = yield* fileSystem.makeTempFileScoped({
        prefix: "t3-acp-direct-stop-command-",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => cleanupPublishedDetachedFixture(commandPidPath)),
      );
      let cancelCalled = false;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          extractBackgroundTaskId: (toolCall) =>
            toolCall.toolCallId === "tool-call-running-1" ? "task-running-1" : undefined,
          extractBackgroundTaskCompletion: (toolCall) =>
            toolCall.toolCallId === "tool-call-output-1"
              ? [{ taskId: "task-running-1", status: "running", appendOutput: "" }]
              : [],
          interruptPromptOnCancel: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDescendantProcessGroups: true,
            ownDetachedProcessGroup: true,
            environment: (runtimeOrdinal) =>
              runtimeOrdinal === 1
                ? {
                    T3_ACP_EMIT_RUNNING_COMMAND_THEN_HANG: "1",
                    T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
                    T3_ACP_RUNNING_COMMAND_PID_PATH: commandPidPath,
                    T3_ACP_RUNNING_COMMAND_IGNORE_TERM: "1",
                    T3_ACP_RUNNING_COMMAND_SEPARATE_SESSION: "1",
                  }
                : {},
            protocolEvents,
            wrapCancel: () =>
              Effect.sync(() => {
                cancelCalled = true;
              }).pipe(Effect.andThen(Effect.never)),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-direct-stop-running-command");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-direct-stop-running-command",
        ),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);

      let runningMonitorSeen = false;
      let runningTaskOutputSeen = false;
      while (!runningMonitorSeen || !runningTaskOutputSeen) {
        const event = yield* Queue.take(events);
        if (
          event.type === "turn_item.updated" &&
          (event.turnItem.status === "running" || event.turnItem.status === "pending")
        ) {
          if (event.turnItem.nativeItemRef?.nativeId === "tool-call-running-1") {
            runningMonitorSeen = true;
          }
          if (event.turnItem.nativeItemRef?.nativeId === "tool-call-output-1") {
            runningTaskOutputSeen = true;
          }
        }
      }
      const [commandLauncherPid, commandRootPid, commandSleepPid] = Option.getOrThrow(
        yield* waitForPublishedProcessIds(fileSystem, commandPidPath, 3),
      );
      assert.isTrue(
        Option.isSome(
          yield* waitForProcesses([commandLauncherPid!, commandRootPid!, commandSleepPid!]),
        ),
        "declared direct Stop launcher, Bash, and sleep PIDs must become live",
      );

      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      yield* Queue.takeAll(events);
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: firstProviderTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      const interruptCompleted = yield* Fiber.join(interruptFiber).pipe(
        Effect.timeoutOption("3 seconds"),
      );
      assert.isTrue(Option.isSome(interruptCompleted), "hung ACP cancel must not block teardown");
      assert.isFalse(cancelCalled, "hard process-group teardown must skip ACP cancel");
      yield* Effect.sleep("250 millis");
      assert.isFalse(processExists(commandLauncherPid!));
      assert.isFalse(processExists(commandRootPid!));
      assert.isFalse(processExists(commandSleepPid!));

      let terminalStatus: string | null = null;
      let openToolTerminalStatus: string | null = null;
      let openToolInterruptedExitCode: number | undefined = 42;
      let lateAfterCancelSeen = false;
      let runningMonitorAfterInterrupt = false;
      while (terminalStatus === null || openToolTerminalStatus === null) {
        const event = yield* Queue.take(events);
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tool-call-running-1" &&
          event.turnItem.status === "running"
        ) {
          runningMonitorAfterInterrupt = true;
          if (event.turnItem.type === "command_execution") {
            assert.equal(
              event.turnItem.exitCode,
              undefined,
              "mid-stream exit_code 0 must not project while the command is still running",
            );
          }
        }
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          (event.turnItem.status === "failed" ||
            event.turnItem.status === "cancelled" ||
            event.turnItem.status === "interrupted" ||
            event.turnItem.status === "completed")
        ) {
          openToolTerminalStatus = event.turnItem.status;
          openToolInterruptedExitCode = event.turnItem.exitCode;
        }
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
          terminalStatus = event.status;
        }
        if (
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text.includes("late after cancel")
        ) {
          lateAfterCancelSeen = true;
        }
      }
      assert.equal(terminalStatus, "interrupted");
      assert.equal(openToolTerminalStatus, "interrupted");
      assert.equal(
        openToolInterruptedExitCode,
        undefined,
        "interrupted commands must not retain a mid-stream exit_code 0",
      );
      assert.isFalse(runningMonitorAfterInterrupt);
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      assert.isFalse(
        lateAfterCancelSeen,
        "late post-Stop assistant text must not attach to the stopped run",
      );

      // Give residual cancel-path updates a chance to mis-project if quarantine fails.
      yield* Effect.sleep("200 millis");
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      let residual = yield* Queue.poll(events);
      while (Option.isSome(residual)) {
        const event = residual.value;
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tool-call-running-1"
        ) {
          assert.notEqual(event.turnItem.status, "running");
        }
        if (
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text.includes("late after cancel")
        ) {
          lateAfterCancelSeen = true;
        }
        residual = yield* Queue.poll(events);
      }
      assert.isFalse(lateAfterCancelSeen, "quarantine must drop residual stopped-run events");

      const secondNow = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: secondNow,
          ordinal: 2,
        }),
      );
      const loadAfterRestart = yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) => event.direction === "outgoing" && rawProtocolMethod(event) === "session/load",
        ),
        Stream.runHead,
      );
      assert.isTrue(
        Option.isSome(loadAfterRestart),
        "Direct Stop follow-up must respawn the ACP runtime",
      );

      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:2",
      });
      let secondTerminal: string | null = null;
      let stoppedRunTextOnFollowUp = false;
      while (secondTerminal === null) {
        const event = yield* Queue.take(events);
        if (
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text.includes("late after cancel")
        ) {
          stoppedRunTextOnFollowUp = true;
        }
        if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
          secondTerminal = event.status;
        }
      }
      assert.equal(secondTerminal, "completed");
      assert.isFalse(
        stoppedRunTextOnFollowUp,
        "stopped-run residual text must not attach to the follow-up run",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "direct Stop on a deferred subagent hold terminalizes the subagent and does not carry it forward",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        const adapter = makeAcpAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            restartRuntimeAfterInterrupt: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
              protocolEvents,
            }),
          },
          fileSystem,
          idAllocator,
          serverConfig,
        });
        const threadId = ThreadId.make("thread-acp-direct-stop-subagent-hold");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-direct-stop-subagent-hold",
          ),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes('"stopReason"'),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:1",
        });
        const interruptFiber = yield* runtime
          .interruptTurn({
            providerThread,
            providerTurnId: firstProviderTurnId,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        let subagentStatus: string | null = null;
        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentStatus = event.turnItem.status;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.equal(subagentStatus, "interrupted");

        subagentPhase = "complete";
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: "mock-session-1:turn:2",
        });
        let carriedCompleted = false;
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.status === "completed"
          ) {
            carriedCompleted = true;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(secondTerminalStatus, "completed");
        assert.isFalse(
          carriedCompleted,
          "Direct Stop must not carry a stopped subagent into the follow-up run",
        );
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("restart_active terminates native work and reloads a clean runtime", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const commandPidPath = yield* fileSystem.makeTempFileScoped({
        prefix: "t3-acp-restart-active-command-",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => cleanupPublishedDetachedFixture(commandPidPath)),
      );
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          restartRuntimeAfterInterrupt: true,
          restartRuntimeOnEveryInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDescendantProcessGroups: true,
            ownDetachedProcessGroup: true,
            processGroupTerminationGrace: 0,
            environment: (runtimeOrdinal) =>
              runtimeOrdinal === 1
                ? {
                    T3_ACP_EXIT_ON_CANCEL: "1",
                    T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
                    T3_ACP_EMIT_RUNNING_COMMAND_THEN_HANG: "1",
                    T3_ACP_RUNNING_COMMAND_PID_PATH: commandPidPath,
                    T3_ACP_RUNNING_COMMAND_SEPARATE_SESSION: "1",
                  }
                : {},
            protocolEvents,
            wrapCancel: (cancel) => cancel.pipe(Effect.andThen(Effect.sleep("250 millis"))),
          }),
        },
        fileSystem,
        idAllocator,
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-restart-active-in-process");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-restart-active-in-process"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);

      let runningToolSeen = false;
      while (!runningToolSeen) {
        const event = yield* Queue.take(events);
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          (event.turnItem.status === "running" || event.turnItem.status === "pending")
        ) {
          runningToolSeen = true;
        }
      }
      const [commandLauncherPid, commandRootPid, commandSleepPid] = Option.getOrThrow(
        yield* waitForPublishedProcessIds(fileSystem, commandPidPath, 3),
      );
      assert.isTrue(
        Option.isSome(
          yield* waitForProcesses([commandLauncherPid!, commandRootPid!, commandSleepPid!]),
        ),
        "declared restart_active launcher, Bash, and sleep PIDs must become live",
      );

      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:1",
      });
      // restart_active path: interrupt without requestRuntimeRestart.
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: firstProviderTurnId,
        })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(interruptFiber);
      yield* Effect.sleep("250 millis");
      assert.isFalse(processExists(commandLauncherPid!));
      assert.isFalse(processExists(commandRootPid!));
      assert.isFalse(processExists(commandSleepPid!));

      let firstTerminal: string | null = null;
      while (firstTerminal === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
          firstTerminal = event.status;
        }
      }
      assert.equal(firstTerminal, "interrupted");

      yield* Queue.takeAll(protocolEvents);
      yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 2,
          }),
        )
        .pipe(Effect.forkScoped);
      let loadSeen = false;
      let promptSeen = false;
      while (!loadSeen || !promptSeen) {
        const event = yield* Queue.take(protocolEvents);
        if (event.direction !== "outgoing") continue;
        const method = rawProtocolMethod(event);
        loadSeen ||= method === "session/load";
        promptSeen ||= method === "session/prompt";
      }
      assert.isTrue(loadSeen, "restart_active must replay session/load on a new ACP process");
      assert.isTrue(promptSeen, "replacement prompt must start after reload");
      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: "mock-session-1:turn:2",
      });
      let staleEventSeen = false;
      let secondTerminal: string | null = null;
      while (secondTerminal === null) {
        const event = yield* Queue.take(events);
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tool-call-running-1"
        ) {
          staleEventSeen = true;
        }
        if (
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text.includes("late after cancel")
        ) {
          staleEventSeen = true;
        }
        if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
          secondTerminal = event.status;
        }
      }
      assert.equal(secondTerminal, "completed");
      assert.isFalse(staleEventSeen, "interrupted runtime events must not attach to attempt 2");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("acpPostSettleWakeEvidence", () => {
  const sessionId = "session-wake";

  it("accepts assistant text and tool updates as wake evidence", () => {
    assert.isTrue(
      acpPostSettleWakeEvidence({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Subagent finished. SUBAGENT_DONE" },
        },
      }),
    );
    assert.isTrue(
      acpPostSettleWakeEvidence({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "get_command_or_subagent_output",
          status: "pending",
          kind: "other",
          content: [],
          locations: [],
          rawInput: {},
        },
      }),
    );
  });

  it("rejects monitor end chatter and background mutations", () => {
    assert.isFalse(
      acpPostSettleWakeEvidence({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: 'Monitor "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" ended',
          },
        },
      }),
    );
    assert.isFalse(
      acpPostSettleWakeEvidence(
        {
          sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "task-1 completed" },
          },
        },
        {
          extractBackgroundToolMutation: () => [
            {
              taskId: "task-1",
              status: "completed",
              appendOutput: "",
            },
          ],
        },
      ),
    );
  });
});

describe("acpPostSettleContinuationOfferEvidence", () => {
  const sessionId = "session-wake-offer";

  it("offers on assistant text and terminal tool status", () => {
    assert.isTrue(
      acpPostSettleContinuationOfferEvidence({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Background shell finished." },
        },
      }),
    );
    assert.isTrue(
      acpPostSettleContinuationOfferEvidence({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          title: "run_terminal_command",
          status: "completed",
          kind: "other",
          content: [],
          locations: [],
          rawInput: {},
        },
      }),
    );
    assert.isTrue(
      acpPostSettleContinuationOfferEvidence({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-2",
          title: "run_terminal_command",
          status: "failed",
          kind: "other",
          content: [],
          locations: [],
          rawInput: {},
        },
      }),
    );
  });

  it("does not offer on thought-only chunks", () => {
    assert.isFalse(
      acpPostSettleContinuationOfferEvidence({
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Still reasoning about the monitor output…" },
        },
      }),
    );
    // Thoughts may still be wake evidence for buffering once a real offer opens.
    assert.isTrue(
      acpPostSettleWakeEvidence({
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Still reasoning about the monitor output…" },
        },
      }),
    );
  });

  it("buffers in-progress tool updates without offering", () => {
    assert.isTrue(
      acpPostSettleWakeEvidence({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          title: "run_terminal_command",
          status: "in_progress",
          kind: "other",
          content: [],
          locations: [],
          rawInput: {},
        },
      }),
    );
    assert.isFalse(
      acpPostSettleContinuationOfferEvidence({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          title: "run_terminal_command",
          status: "in_progress",
          kind: "other",
          content: [],
          locations: [],
          rawInput: {},
        },
      }),
    );
    assert.isFalse(
      acpPostSettleContinuationOfferEvidence({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "run_terminal_command",
          status: "pending",
          kind: "other",
          content: [],
          locations: [],
          rawInput: {},
        },
      }),
    );
  });

  it("does not offer filtered monitor chatter", () => {
    assert.isFalse(
      acpPostSettleContinuationOfferEvidence({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: 'Monitor "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" ended',
          },
        },
      }),
    );
  });

  it("does not offer on a normalized monitor start ACK despite raw completed status", () => {
    const monitorStartAck = {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-monitor",
        title: "Tool",
        status: "completed",
        kind: "other",
        content: [],
        locations: [],
        rawInput: { variant: "Monitor", description: "stream test" },
        rawOutput: {
          type: "Monitor",
          taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          timeoutMs: 60000,
        },
      },
    } as const;
    // Raw frame looks terminal; the Grok flavor knows it is a running monitor.
    assert.isTrue(acpPostSettleContinuationOfferEvidence(monitorStartAck));
    assert.isFalse(
      acpPostSettleContinuationOfferEvidence(monitorStartAck, {
        normalizeToolCall: normalizeXAiAcpToolCallState,
      }),
    );
  });
});

describe("acpPostSettleWakeShouldBuffer", () => {
  const sessionId = "session-wake-buffer";

  it("drops agent progress chatter while background work is running", () => {
    for (const sessionUpdate of ["agent_message_chunk", "agent_thought_chunk"] as const) {
      assert.isFalse(
        acpPostSettleWakeShouldBuffer(
          {
            sessionId,
            update: {
              sessionUpdate,
              content: { type: "text", text: "Still running." },
            },
          },
          true,
        ),
      );
    }
  });

  it("retains tool state while running and agent output after completion", () => {
    const agentMessage = {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Monitor finished successfully." },
      },
    } as const;
    const toolUpdate = {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-monitor",
        title: "monitor",
        status: "in_progress",
        kind: "other",
        content: [],
        locations: [],
        rawInput: {},
      },
    } as const;

    assert.isTrue(acpPostSettleWakeShouldBuffer(toolUpdate, true));
    assert.isTrue(acpPostSettleWakeShouldBuffer(agentMessage, false));
  });
});

describe("acpPostSettleMonitorPromptShouldSuppress", () => {
  it("suppresses running monitor prompts but not terminal notices", () => {
    assert.isTrue(
      acpPostSettleMonitorPromptShouldSuppress({ taskId: "task-active", status: "running" }),
    );
    assert.isFalse(
      acpPostSettleMonitorPromptShouldSuppress({ taskId: "task-ended", status: "completed" }),
    );
    assert.isFalse(
      acpPostSettleMonitorPromptShouldSuppress({ taskId: "task-failed", status: "failed" }),
    );
  });
});
