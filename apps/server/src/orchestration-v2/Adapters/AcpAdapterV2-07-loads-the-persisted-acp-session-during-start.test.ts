// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import {
  extractCopilotSubagentUpdate,
  makeCopilotSubagentRouting,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
  extractDevinSubagentUpdate,
  makeAcpRegistryAdapterV2,
} from "@t3tools/provider-acp-registry/testing";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { decodeAcpReplayTranscript, makeAcpReplayRuntime } from "./AcpAdapterV2.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DocumentText from "../../provider/DocumentText.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderOptionDescriptor,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deriveBlockedOnThreadWait } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
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
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  ACP_EMPTY_OPTION_VALUE,
  ACP_SESSION_MODE_OPTION_ID,
  acpProviderOptionDescriptors,
} from "@t3tools/provider-acp/server/sessionConfig";
import {
  extractXAiAcpSubagentUpdate,
  makeGrokAdapterV2,
  makeXAiPromptCompletionRuntime,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
} from "@t3tools/provider-grok/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  AcpProviderCapabilitiesV2,
  acpPerTurnPromptUsage,
  acpScopedNativeId,
  acpPostSettleContinuationOfferEvidence,
  acpPostSettleWakeEvidence,
  acpToolCallDiffPatch,
  acpToolCallSnippetEdit,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import { appendUserInputAttachmentPaths } from "../../provider/userInputAttachments.ts";
import { makeGrokAcpAdapterFlavor } from "@t3tools/provider-grok/testing";
import {
  acpRegistryPromptFailure,
  registerMistralVibeAcpExtensions,
} from "@t3tools/provider-acp-registry/testing";

import {
  layerTest,
  ACP_TEST_DRIVER,
  makeMockRuntime,
  rawProtocolMethod,
  rawProtocolRequest,
  pollProtocolMethods,
  sessionId,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.live(
    "loads the persisted ACP session during startup without creating a throwaway session",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const instanceId = ProviderInstanceId.make("acp-test-eager-resume");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              protocolEvents,
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-eager-resume");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-eager-resume"),
          modelSelection,
          runtimePolicy,
          initialNativeThreadId: "persisted-session",
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        assert.equal(providerThread.nativeThreadRef?.nativeId, "persisted-session");
        assert.isNull(providerThread.nativeMetadata);
        const startupMethods = yield* pollProtocolMethods(protocolEvents);
        assert.include(startupMethods, "session/resume");
        assert.notInclude(startupMethods, "session/new");

        yield* runtime.resumeThread({ providerThread, modelSelection, runtimePolicy });
        assert.notInclude(yield* pollProtocolMethods(protocolEvents), "session/resume");
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 1,
          }),
        );
        const terminal = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        ).find((event) => event.type === "turn.terminal");
        assert.equal(
          terminal?.providerTurnId,
          idAllocator.derive.providerTurn({
            driver: ACP_TEST_DRIVER,
            nativeTurnId: "persisted-session:turn:1",
          }),
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("creates a fresh ACP identity when recovering an exhausted target", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-exhausted-target");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            wrapRuntime: (runtime, ordinal) => ({
              ...runtime,
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) => ({
                    ...started,
                    sessionId: `mock-recovery-session-${ordinal}`,
                  })),
                ),
            }),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-exhausted-target");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-exhausted-target"),
        modelSelection,
        runtimePolicy,
      });
      const original = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread: original,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 1,
        }),
      );
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const replacement = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
        existingProviderThread: { ...original, nativeThreadRef: null },
        forceNewNativeThread: true,
      });
      assert.notEqual(replacement.nativeThreadRef?.nativeId, original.nativeThreadRef?.nativeId);
      assert.equal(replacement.id, original.id);
      assert.equal(replacement.nativeMetadata?.itemIdentityVersion, 2);
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread: replacement,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
        }),
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      assert.isTrue(
        events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
      );
      const methods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(methods.filter((method) => method === "session/new").length, 2);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("preserves new-session fallback when an eager ACP session load is stale", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-stale-eager-resume");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: (runtimeOrdinal) =>
              runtimeOrdinal === 1 ? { T3_ACP_FAIL_LOAD_SESSION: "1" } : {},
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-stale-eager-resume");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-stale-eager-resume"),
        modelSelection,
        runtimePolicy,
        initialNativeThreadId: "stale-session",
      });
      const replacementThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const staleThread: OrchestrationV2ProviderThread = {
        ...replacementThread,
        nativeMetadata: null,
        nativeThreadRef: {
          driver: ACP_TEST_DRIVER,
          nativeId: "stale-session",
          strength: "strong",
        },
      };

      const startupMethods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(startupMethods.filter((method) => method === "session/resume").length, 1);
      assert.equal(startupMethods.filter((method) => method === "session/new").length, 1);

      const resumeError = yield* runtime
        .resumeThread({ providerThread: staleThread, modelSelection, runtimePolicy })
        .pipe(Effect.flip);
      assert.equal(resumeError._tag, "ProviderAdapterResumeThreadError");
      assert.notInclude(yield* pollProtocolMethods(protocolEvents), "session/resume");
      assert.notEqual(replacementThread.nativeThreadRef?.nativeId, "stale-session");
      const preservedReplacement = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal(preservedReplacement.nativeMetadata?.itemIdentityVersion, 2);
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread: preservedReplacement,
          instanceId,
          runtimePolicy,
          now,
          ordinal: 1,
        }),
      );
      const terminal = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).find((event) => event.type === "turn.terminal");
      assert.equal(
        terminal?.providerTurnId,
        idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(
            instanceId,
            `${preservedReplacement.nativeThreadRef?.nativeId}:turn:1`,
          ),
        }),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("replaces an unexpectedly terminated ACP runtime before the next turn", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
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
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => {
              runtimeInputs.push(runtimeInput);
            }).pipe(Effect.andThen(baseMakeRuntime(runtimeInput))),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-unexpected-termination");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("does not poll the process ledger while a cgroup lease owns teardown", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") return;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      // A directory stands in for cgroupfs: the join wrapper appends the agent
      // PID to cgroup.procs and stays in this process's cgroup, which is the
      // cgroup the lease reports.
      const leasePath = yield* fileSystem.makeTempDirectoryScoped();
      const procsPath = path.join(leasePath, "cgroup.procs");
      yield* fileSystem.writeFileString(procsPath, "");
      const relativePath = AcpSessionRuntime.parseUnifiedCgroupPath(
        NodeFS.readFileSync("/proc/self/cgroup", "utf8"),
      );
      // No unified cgroup on this host means no lease is possible, so there is
      // nothing for this test to exercise.
      if (relativePath === undefined) return;
      const processTree = AcpSessionRuntime.makePosixProcessTreeController("linux");
      const leasePids = () =>
        NodeFS.readFileSync(procsPath, "utf8").split(/\s+/).filter(Boolean).map(Number);
      const isLive = (pid: number) => {
        const identity = processTree.identity(pid);
        return identity !== undefined && !AcpSessionRuntime.posixProcessIsZombie(identity);
      };
      let leaseExists = true;
      const linuxCgroupController: AcpSessionRuntime.AcpLinuxCgroupController = {
        create: () => ({
          contains: (pid) => leasePids().includes(pid),
          exists: () => leaseExists,
          path: leasePath,
          relativePath,
          kill: () => {
            for (const pid of leasePids().filter(isLive)) process.kill(pid, "SIGKILL");
          },
          populated: () => leasePids().some(isLive),
          remove: () => {
            leaseExists = false;
          },
        }),
      };
      let childListReads = 0;
      const posixProcessTreeController: AcpSessionRuntime.AcpPosixProcessTreeController = {
        ...processTree,
        childPidsOf: (pid) => {
          childListReads += 1;
          return processTree.childPidsOf(pid);
        },
      };
      const instanceId = ProviderInstanceId.make("acp-test-cgroup-ledger-idle");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            linuxCgroupController,
            posixProcessTreeController,
            mockAgentPath,
            ownDescendantProcessGroups: true,
            ownDetachedProcessGroup: true,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-cgroup-ledger-idle");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.fork(yield* Scope.Scope);
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-cgroup-ledger-idle"),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      // The agent's children are listed once, to capture the root it may
      // signal at teardown, and never again while the session is open.
      assert.equal(childListReads, 1);

      const agentPid = leasePids()[0];
      assert.isDefined(agentPid);
      yield* Scope.close(sessionScope, Exit.void);
      assert.isFalse(isLive(agentPid!), "closing the session must still tear the agent down");
      assert.isFalse(leaseExists, "closing the session must remove the lease");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("negotiates and executes optional native session forks through the ACP runtime", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let createTerminal: Parameters<RuntimeService["handleCreateTerminal"]>[0] | undefined;
      let readTerminalOutput: Parameters<RuntimeService["handleTerminalOutput"]>[0] | undefined;
      let waitForTerminalExit:
        | Parameters<RuntimeService["handleTerminalWaitForExit"]>[0]
        | undefined;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        protocolEvents,
        wrapRuntime: (runtime) => ({
          ...runtime,
          handleCreateTerminal: (handler) =>
            Effect.sync(() => {
              createTerminal = handler;
            }).pipe(Effect.andThen(runtime.handleCreateTerminal(handler))),
          handleTerminalOutput: (handler) =>
            Effect.sync(() => {
              readTerminalOutput = handler;
            }).pipe(Effect.andThen(runtime.handleTerminalOutput(handler))),
          handleTerminalWaitForExit: (handler) =>
            Effect.sync(() => {
              waitForTerminalExit = handler;
            }).pipe(Effect.andThen(runtime.handleTerminalWaitForExit(handler))),
        }),
      });

      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime,
        },
        selfInvocation,
        clientTerminals: {},
      });
      const sourceThreadId = ThreadId.make("thread-acp-native-fork-source");
      const targetThreadId = ThreadId.make("thread-acp-native-fork-target");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-native-fork-source"),
        threadId: sourceThreadId,
        providerSessionId: "mcp-session-acp-native-fork-source",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer source-thread-token",
        browserToolsAvailable: true,
      });
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-native-fork"),
        threadId: targetThreadId,
        providerSessionId: "mcp-session-acp-native-fork",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer target-thread-token",
        browserToolsAvailable: true,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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
      assert.isTrue(runtime.providerSession.capabilities.sessions.supportsModelSwitchInSession);
      assert.isFalse(
        runtime.providerSession.capabilities.sessions.supportsRuntimeModeSwitchInSession,
      );

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
            type: "stdio",
            name: "t3-code",
            command: process.execPath,
            args: [
              process.argv[1] === undefined ? "t3" : NodePath.resolve(process.argv[1]),
              "acp-mcp-bridge",
            ],
            env: [
              { name: "ELECTRON_RUN_AS_NODE", value: "1" },
              { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:43123/mcp" },
              { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer target-thread-token" },
            ],
          },
        ],
      });
      yield* runtime.ensureThread({
        threadId: sourceThreadId,
        modelSelection,
        runtimePolicy,
      });
      if (
        createTerminal === undefined ||
        readTerminalOutput === undefined ||
        waitForTerminalExit === undefined
      ) {
        return yield* Effect.die("ACP runtime must register terminal handlers");
      }
      const unknownTerminal = yield* createTerminal(
        {
          sessionId: "mock-child-session-without-credential-scope",
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.env.T3_ACP_MCP_AUTHORIZATION ?? '')"],
        },
        { requestId: "test-unknown-terminal-create", method: "terminal/create" },
      );
      yield* waitForTerminalExit(
        {
          sessionId: "mock-child-session-without-credential-scope",
          terminalId: unknownTerminal.terminalId,
        },
        { requestId: "test-unknown-terminal-wait", method: "terminal/wait_for_exit" },
      );
      const unknownTerminalOutput = yield* readTerminalOutput(
        {
          sessionId: "mock-child-session-without-credential-scope",
          terminalId: unknownTerminal.terminalId,
        },
        { requestId: "test-unknown-terminal-output", method: "terminal/output" },
      );
      assert.equal(unknownTerminalOutput.output, "");

      const terminal = yield* createTerminal(
        {
          sessionId: "mock-session-1-fork",
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.env.T3_ACP_MCP_AUTHORIZATION ?? '')"],
        },
        { requestId: "test-terminal-create", method: "terminal/create" },
      );
      yield* waitForTerminalExit(
        {
          sessionId: "mock-session-1-fork",
          terminalId: terminal.terminalId,
        },
        { requestId: "test-terminal-wait", method: "terminal/wait_for_exit" },
      );
      const terminalOutput = yield* readTerminalOutput(
        {
          sessionId: "mock-session-1-fork",
          terminalId: terminal.terminalId,
        },
        { requestId: "test-terminal-output", method: "terminal/output" },
      );
      assert.equal(terminalOutput.output, "Bearer target-thread-token");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
