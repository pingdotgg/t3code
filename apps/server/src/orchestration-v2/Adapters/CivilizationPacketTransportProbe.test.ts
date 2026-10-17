// @effect-diagnostics nodeBuiltinImport:off -- the probe copies upstream replay fixtures
/**
 * Phase 0 gate G2 probe (experiments/phase-0/E02): bounded civilization packets
 * on the real provider-bound transport.
 *
 * Adapter-level on purpose: the orchestrator replay harness hardcodes
 * `McpAppModelContext.layerEmpty` and `ProviderTurnStartService.testkit.ts` has
 * no turn-input hook, so this probe drives the two adapters directly and reads
 * the wire frames their turn input produces:
 *
 * - Codex: the packet rides `additionalContext` under the fixed key
 *   `t3_civilization` (untrusted), so each turn's packet replaces the previous
 *   one; resume goes through the same per-turn builder.
 * - Claude: the latest packet is prepended to each new actionable prompt and
 *   never concatenated; provider-continuation turns (no prompt) and slash
 *   commands (`/compact`) stay untouched.
 *
 * Each test also pins "no extra model run": exactly one turn/start or one
 * offered prompt per turn.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  CodexSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig, withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const CLAUDE_PACKET_NATIVE_SESSION = "native-thread-claude-packet";

const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5000; attempt++) {
      if (predicate()) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Timed out waiting for ${label}.`);
  });

type Packet = NonNullable<ProviderAdapter.ProviderAdapterV2TurnInput["civilizationPacket"]>;

const testLayers = Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer);

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly overrides?: Partial<OrchestrationV2AppThread>;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Civilization packet probe",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
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
    lastVisitedAt: null,
    deletedAt: null,
    ...input.overrides,
  };
}

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly providerTurnOrdinal?: number;
  readonly civilizationPacket?: Packet;
  readonly appThreadOverrides?: Partial<OrchestrationV2AppThread>;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread({
      ...input,
      ...(input.appThreadOverrides === undefined ? {} : { overrides: input.appThreadOverrides }),
    }),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    ...(input.civilizationPacket === undefined
      ? {}
      : { civilizationPacket: input.civilizationPacket }),
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
  ];
}

function codexTurnEntries(input: {
  readonly requestId: number;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  readonly packet?: Packet;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: input.requestId,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
          ...(input.packet === undefined
            ? {}
            : {
                additionalContext: {
                  t3_civilization: { kind: "untrusted", value: input.packet.text },
                },
              }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: input.requestId,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "completed" }),
        },
      },
    },
  ];
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

const makeCodexPacketHarness = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  onRequest: (method: string, params: unknown) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: (openInput) =>
        Layer.build(CodexReplay.layerReplay(transcript)).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.map((client) => withCodexReplayChildMetadata(client, transcript)),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      onRequest(method, params).pipe(
                        Effect.andThen(client.request(method, params)),
                      ),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.provide(context),
            ),
          ),
        ),
    };
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory,
      crypto: yield* Crypto.Crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests: {
        offer: (_request: ProviderContinuationRequests.ProviderContinuationRequest) => Effect.void,
      },
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return { adapter, runtime, providerThread, threadId, terminalEvents };
  });

type CodexPacketHarness = Effect.Success<ReturnType<typeof makeCodexPacketHarness>>;

const runCodexPacketProbe = <A, E>(
  scenario: string,
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
  build: (harness: CodexPacketHarness) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const captured: Array<Record<string, unknown>> = [];
    const transcript = makeCodexReplayTranscript({ scenario, entries });
    const harness = yield* makeCodexPacketHarness(transcript, (method, params) =>
      Effect.sync(() => {
        if (method === "turn/start" && typeof params === "object" && params !== null) {
          captured.push(params as Record<string, unknown>);
        }
      }),
    );
    const value = yield* build(harness);
    return { value, captured };
  });

describe("CodexAdapterV2 civilization packet transport", () => {
  it.effect("delivers the packet keyed on a fresh turn and replaces it on the next turn", () =>
    Effect.gen(function* () {
      const nativeThreadId = "packet-fresh-thread";
      const firstPacket: Packet = {
        revision: "rev-1",
        text: "CIVILIZATION PACKET rev-1\nWorld: Alpha",
      };
      const secondPacket: Packet = {
        revision: "rev-2",
        text: "CIVILIZATION PACKET rev-2\nWorld: Beta",
      };
      const { value: codexTransport, captured } = yield* runCodexPacketProbe(
        "civilization-packet-fresh-replace",
        [
          ...codexReplayPreamble({ nativeThreadId }),
          ...codexTurnEntries({
            requestId: 3,
            nativeThreadId,
            nativeTurnId: "packet-fresh-turn-1",
            prompt: "First prompt.",
            packet: firstPacket,
          }),
          ...codexTurnEntries({
            requestId: 4,
            nativeThreadId,
            nativeTurnId: "packet-fresh-turn-2",
            prompt: "Second prompt.",
            packet: secondPacket,
          }),
        ],
        (harness) =>
          Effect.gen(function* () {
            const transport = harness.adapter.civilizationContextTransport;
            assert.deepEqual(transport, {
              kind: "codex.additional_context",
              description: "turn/start params.additionalContext.t3_civilization.value",
              trust: "untrusted",
            });
            const now = yield* DateTime.now;
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-fresh-1"),
                text: "First prompt.",
                civilizationPacket: firstPacket,
              }),
            );
            yield* awaitUntil(
              () => harness.terminalEvents().length === 1,
              "first Codex turn terminal",
            );
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-fresh-2"),
                text: "Second prompt.",
                providerTurnOrdinal: 2,
                civilizationPacket: secondPacket,
              }),
            );
            yield* awaitUntil(
              () => harness.terminalEvents().length === 2,
              "second Codex turn terminal",
            );
            return transport;
          }),
      );
      assert.deepEqual(codexTransport, {
        kind: "codex.additional_context",
        description: "turn/start params.additionalContext.t3_civilization.value",
        trust: "untrusted",
      });
      assert.lengthOf(captured, 2, "exactly one turn/start per turn (no extra model run)");
      assert.nestedPropertyVal(captured[0], "additionalContext.t3_civilization.kind", "untrusted");
      assert.nestedPropertyVal(
        captured[0],
        "additionalContext.t3_civilization.value",
        firstPacket.text,
      );
      assert.nestedPropertyVal(
        captured[1],
        "additionalContext.t3_civilization.value",
        secondPacket.text,
      );
      assert.isFalse(
        JSON.stringify(captured[1]).includes(firstPacket.text),
        "the second turn must not resend the first packet",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("sends no civilization context when the packet is absent", () =>
    Effect.gen(function* () {
      const nativeThreadId = "packet-absent-thread";
      const { captured } = yield* runCodexPacketProbe(
        "civilization-packet-absent",
        [
          ...codexReplayPreamble({ nativeThreadId }),
          ...codexTurnEntries({
            requestId: 3,
            nativeThreadId,
            nativeTurnId: "packet-absent-turn-1",
            prompt: "Unadopted prompt.",
          }),
        ],
        (harness) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-absent-1"),
                text: "Unadopted prompt.",
              }),
            );
            yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex turn terminal");
          }),
      );
      assert.lengthOf(captured, 1);
      assert.isUndefined(
        captured[0]!["additionalContext"],
        "disable path must leave the turn/start frame untouched",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("re-delivers the same packet when a turn is retried with the same revision", () =>
    Effect.gen(function* () {
      const nativeThreadId = "packet-retry-thread";
      const packet: Packet = { revision: "rev-1", text: "CIVILIZATION PACKET rev-1" };
      const { captured } = yield* runCodexPacketProbe(
        "civilization-packet-retry",
        [
          ...codexReplayPreamble({ nativeThreadId }),
          ...codexTurnEntries({
            requestId: 3,
            nativeThreadId,
            nativeTurnId: "packet-retry-turn-1",
            prompt: "Flaky prompt.",
            packet,
          }),
          ...codexTurnEntries({
            requestId: 4,
            nativeThreadId,
            nativeTurnId: "packet-retry-turn-2",
            prompt: "Flaky prompt.",
            packet,
          }),
        ],
        (harness) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-retry-1"),
                text: "Flaky prompt.",
                civilizationPacket: packet,
              }),
            );
            yield* awaitUntil(
              () => harness.terminalEvents().length === 1,
              "first Codex turn terminal",
            );
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-retry-2"),
                text: "Flaky prompt.",
                providerTurnOrdinal: 2,
                civilizationPacket: packet,
              }),
            );
            yield* awaitUntil(
              () => harness.terminalEvents().length === 2,
              "retried Codex turn terminal",
            );
          }),
      );
      assert.lengthOf(captured, 2);
      assert.nestedPropertyVal(captured[0], "additionalContext.t3_civilization.value", packet.text);
      assert.nestedPropertyVal(captured[1], "additionalContext.t3_civilization.value", packet.text);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("keeps delivering the latest packet across a resume", () =>
    Effect.gen(function* () {
      const nativeThreadId = "packet-resume-thread";
      const firstPacket: Packet = { revision: "rev-1", text: "CIVILIZATION PACKET rev-1" };
      const secondPacket: Packet = { revision: "rev-2", text: "CIVILIZATION PACKET rev-2" };
      const { captured } = yield* runCodexPacketProbe(
        "civilization-packet-resume",
        [
          ...codexReplayPreamble({ nativeThreadId }),
          ...codexTurnEntries({
            requestId: 3,
            nativeThreadId,
            nativeTurnId: "packet-resume-turn-1",
            prompt: "Before resume.",
            packet: firstPacket,
          }),
          {
            type: "expect_outbound",
            label: "thread/resume",
            frame: {
              id: 4,
              method: "thread/resume",
              params: {
                threadId: nativeThreadId,
                excludeTurns: true,
                cwd: "/workspace",
                model: "gpt-5.4",
                config: CodexAdapterV2.CODEX_THREAD_CONFIG,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/resume",
            frame: { id: 4, result: { thread: { id: nativeThreadId, updatedAt: 1782622440 } } },
          },
          ...codexTurnEntries({
            requestId: 5,
            nativeThreadId,
            nativeTurnId: "packet-resume-turn-2",
            prompt: "After resume.",
            packet: secondPacket,
          }),
        ],
        (harness) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-resume-1"),
                text: "Before resume.",
                civilizationPacket: firstPacket,
              }),
            );
            yield* awaitUntil(
              () => harness.terminalEvents().length === 1,
              "pre-resume Codex turn terminal",
            );
            yield* harness.runtime.resumeThread({
              providerThread: harness.providerThread,
              modelSelection: CODEX_TEST_MODEL_SELECTION,
              runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
            });
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-resume-2"),
                text: "After resume.",
                providerTurnOrdinal: 2,
                civilizationPacket: secondPacket,
              }),
            );
            yield* awaitUntil(
              () => harness.terminalEvents().length === 2,
              "post-resume Codex turn terminal",
            );
          }),
      );
      assert.lengthOf(captured, 2);
      assert.nestedPropertyVal(
        captured[1],
        "additionalContext.t3_civilization.value",
        secondPacket.text,
        "resumed sessions get the latest packet, not the old one",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("keeps the latest keyed packet on a fork-equivalent turn input", () =>
    Effect.gen(function* () {
      const nativeThreadId = "packet-fork-thread";
      const packet: Packet = { revision: "rev-fork", text: "CIVILIZATION PACKET rev-fork" };
      const { captured } = yield* runCodexPacketProbe(
        "civilization-packet-fork-equivalent",
        [
          ...codexReplayPreamble({ nativeThreadId }),
          ...codexTurnEntries({
            requestId: 3,
            nativeThreadId,
            nativeTurnId: "packet-fork-turn-1",
            prompt: "Forked prompt.",
            packet,
          }),
        ],
        (harness) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const parentId = ThreadId.make("thread-civilization-packet-parent");
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-fork-1"),
                text: "Forked prompt.",
                civilizationPacket: packet,
                appThreadOverrides: {
                  lineage: {
                    parentThreadId: parentId,
                    relationshipToParent: "fork",
                    rootThreadId: parentId,
                  },
                },
              }),
            );
            yield* awaitUntil(() => harness.terminalEvents().length === 1, "fork Codex terminal");
          }),
      );
      assert.lengthOf(captured, 1);
      assert.nestedPropertyVal(captured[0], "additionalContext.t3_civilization.value", packet.text);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("keeps the latest keyed packet on a provider-switch-equivalent fresh input", () =>
    Effect.gen(function* () {
      const nativeThreadId = "packet-provider-switch-thread";
      const packet: Packet = {
        revision: "rev-switch",
        text: "CIVILIZATION PACKET rev-switch",
      };
      const { captured } = yield* runCodexPacketProbe(
        "civilization-packet-provider-switch-equivalent",
        [
          ...codexReplayPreamble({ nativeThreadId }),
          ...codexTurnEntries({
            requestId: 3,
            nativeThreadId,
            nativeTurnId: "packet-provider-switch-turn-1",
            prompt: "First prompt after provider switch.",
            packet,
          }),
        ],
        (harness) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("packet-provider-switch-1"),
                text: "First prompt after provider switch.",
                civilizationPacket: packet,
              }),
            );
            yield* awaitUntil(
              () => harness.terminalEvents().length === 1,
              "provider-switch Codex terminal",
            );
          }),
      );
      assert.lengthOf(captured, 1, "provider switch must not synthesize an extra model turn");
      assert.nestedPropertyVal(captured[0], "additionalContext.t3_civilization.value", packet.text);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );
});

const claudeSdkFrame = (frame: unknown): SDKMessage => frame as SDKMessage;

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly overrides?: Partial<OrchestrationV2AppThread>;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Civilization packet probe",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
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
    lastVisitedAt: null,
    deletedAt: null,
    ...input.overrides,
  };
}

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly providerTurnOrdinal?: number;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly civilizationPacket?: Packet;
  readonly appThreadOverrides?: Partial<OrchestrationV2AppThread>;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread({
      ...input,
      ...(input.appThreadOverrides === undefined ? {} : { overrides: input.appThreadOverrides }),
    }),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    ...(input.civilizationPacket === undefined
      ? {}
      : { civilizationPacket: input.civilizationPacket }),
  };
}

const makeClaudeAssistantFrame = (input: {
  readonly uuid: string;
  readonly text: string;
}): SDKMessage =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: input.uuid,
    session_id: CLAUDE_PACKET_NATIVE_SESSION,
  });

const makeClaudeResultFrame = (input: {
  readonly uuid: string;
  readonly result: string;
  readonly origin?: { readonly kind: "task-notification" };
}): SDKMessage =>
  claudeSdkFrame({
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: input.result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: input.uuid,
    session_id: CLAUDE_PACKET_NATIVE_SESSION,
    terminal_reason: "completed",
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  });

const claudeWakeTaskStarted = claudeSdkFrame({
  type: "system",
  subtype: "task_started",
  task_id: "packet-probe-task",
  tool_use_id: "toolu_packet_probe",
  description: "Packet probe background task",
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "00000000-0000-4000-8000-000000000201",
  session_id: CLAUDE_PACKET_NATIVE_SESSION,
});

const claudeWakeNotification = claudeSdkFrame({
  type: "system",
  subtype: "task_notification",
  task_id: "packet-probe-task",
  tool_use_id: "toolu_packet_probe",
  status: "completed",
  output_file: "/tmp/claude-replay/tasks/packet-probe-task.output",
  summary: 'Background command "Packet probe" completed (exit code 0)',
  uuid: "00000000-0000-4000-8000-000000000202",
  session_id: CLAUDE_PACKET_NATIVE_SESSION,
});

const claudeWakeTurnInit = claudeSdkFrame({
  type: "system",
  subtype: "init",
  uuid: "00000000-0000-4000-8000-000000000203",
  session_id: CLAUDE_PACKET_NATIVE_SESSION,
});

const makeClaudePacketHarness = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-packet-probe-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const offeredMessages: Array<SDKUserMessage> = [];
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }),
      },
      queryRunner: {
        allocateSessionId: Effect.succeed(CLAUDE_PACKET_NATIVE_SESSION),
        open: (_input) =>
          Effect.succeed({
            messages: Stream.fromQueue(sdkMessages),
            offer: (message: SDKUserMessage) =>
              Effect.sync(() => {
                offeredMessages.push(message);
              }),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Queue.shutdown(sdkMessages),
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-packet-probe");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-packet-probe"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    const offeredText = (index: number): string => {
      const message = offeredMessages[index];
      if (message === undefined) throw new Error(`No offered prompt at index ${index}.`);
      const content = message.message.content;
      if (typeof content === "string") return content;
      return content.map((block) => (block.type === "text" ? block.text : "")).join("");
    };
    return {
      adapter,
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      offeredMessages,
      offeredText,
      continuationRequests,
      terminalEvents,
    };
  });

type ClaudePacketHarness = Effect.Success<ReturnType<typeof makeClaudePacketHarness>>;

const offerClaudeResultAndSettle = (
  harness: ClaudePacketHarness,
  uuid: string,
  expectedTerminals: number,
) =>
  Effect.gen(function* () {
    yield* Queue.offer(harness.sdkMessages, makeClaudeResultFrame({ uuid, result: "Done." }));
    yield* awaitUntil(
      () => harness.terminalEvents().length === expectedTerminals,
      `Claude turn terminal ${expectedTerminals}`,
    );
  });

describe("ClaudeAdapterV2 civilization packet transport", () => {
  it.effect("prepends the packet to a fresh prompt and replaces it on the next turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeClaudePacketHarness();
      assert.deepEqual(harness.adapter.civilizationContextTransport, {
        kind: "claude.actionable_prompt_context",
        description:
          "Inserted before actionable user text; Claude effort prefixing may precede it.",
        trust: "untrusted",
      });
      const now = yield* DateTime.now;
      const firstPacket: Packet = {
        revision: "rev-1",
        text: "CIVILIZATION PACKET rev-1\nWorld: Alpha",
      };
      const secondPacket: Packet = {
        revision: "rev-2",
        text: "CIVILIZATION PACKET rev-2\nWorld: Beta",
      };
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-packet-1"),
          text: "First prompt.",
          civilizationPacket: firstPacket,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 1, "first Claude offer");
      assert.equal(
        harness.offeredText(0),
        `Ultrathink:\n${firstPacket.text}\n\nFirst prompt.`,
        "the exact packet is handed to Claude between the effort prefix and actionable user text",
      );
      yield* offerClaudeResultAndSettle(harness, "claude-packet-r1", 1);

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-packet-2"),
          text: "Second prompt.",
          providerTurnOrdinal: 2,
          civilizationPacket: secondPacket,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 2, "second Claude offer");
      const secondOffer = harness.offeredText(1);
      assert.equal(
        secondOffer,
        `Ultrathink:\n${secondPacket.text}\n\nSecond prompt.`,
        "the replacement packet is handed to Claude byte-for-byte before the user text",
      );
      assert.notInclude(
        secondOffer,
        firstPacket.text,
        "the second prompt must not carry the superseded packet",
      );
      assert.lengthOf(
        harness.offeredMessages,
        2,
        "exactly one offered prompt per turn (no extra model run)",
      );
      yield* offerClaudeResultAndSettle(harness, "claude-packet-r2", 2);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("leaves prompts untouched when the packet is absent", () =>
    Effect.gen(function* () {
      const harness = yield* makeClaudePacketHarness();
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-packet-absent"),
          text: "Plain prompt.",
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 1, "Claude offer");
      assert.equal(harness.offeredText(0), "Ultrathink:\nPlain prompt.");
      yield* offerClaudeResultAndSettle(harness, "claude-packet-absent-r", 1);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("does not inject the packet on provider-continuation turns", () =>
    Effect.gen(function* () {
      const harness = yield* makeClaudePacketHarness();
      const now = yield* DateTime.now;
      const packet: Packet = {
        revision: "rev-1",
        text: "CIVILIZATION PACKET rev-1\nWorld: Alpha",
      };
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-continuation-1"),
          text: "Run the build in the background.",
          civilizationPacket: packet,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 1, "Claude offer");
      yield* Queue.offer(harness.sdkMessages, claudeWakeTaskStarted);
      yield* Queue.offer(
        harness.sdkMessages,
        makeClaudeResultFrame({ uuid: "claude-continuation-r1", result: "Started." }),
      );
      yield* awaitUntil(() => harness.terminalEvents().length === 1, "first Claude terminal");

      yield* Queue.offer(harness.sdkMessages, claudeWakeNotification);
      // The wake turn's init frame is what opens the continuation.
      yield* Queue.offer(harness.sdkMessages, claudeWakeTurnInit);
      yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-continuation-2"),
          text: "Background task completed.",
          providerTurnOrdinal: 2,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
          civilizationPacket: packet,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeClaudeAssistantFrame({
          uuid: "00000000-0000-4000-8000-000000000204",
          text: "WAKE_DONE",
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeClaudeResultFrame({
          uuid: "claude-continuation-r2",
          result: "WAKE_DONE",
          origin: { kind: "task-notification" },
        }),
      );
      yield* awaitUntil(() => harness.terminalEvents().length === 2, "wake Claude terminal");
      assert.lengthOf(
        harness.offeredMessages,
        1,
        "a continuation turn must not offer a prompt or a packet",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("does not inject the packet into the /compact prompt", () =>
    Effect.gen(function* () {
      const harness = yield* makeClaudePacketHarness();
      const now = yield* DateTime.now;
      const packet: Packet = {
        revision: "rev-1",
        text: "CIVILIZATION PACKET rev-1\nWorld: Alpha",
      };
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-compact-1"),
          text: "First prompt.",
          civilizationPacket: packet,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 1, "Claude offer");
      yield* offerClaudeResultAndSettle(harness, "claude-compact-r1", 1);

      const compactThread = harness.runtime.compactThread;
      if (compactThread === undefined) {
        throw new Error("Claude adapter runtime must expose compactThread.");
      }
      yield* compactThread(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-compact-2"),
          text: "Summarize and continue.",
          providerTurnOrdinal: 2,
          civilizationPacket: packet,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 2, "compact Claude offer");
      assert.equal(
        harness.offeredText(1),
        "/compact",
        "slash commands must stay the first token so the CLI runs them",
      );
      yield* offerClaudeResultAndSettle(harness, "claude-compact-r2", 2);

      const freshPacket: Packet = {
        revision: "rev-2",
        text: "CIVILIZATION PACKET rev-2\nWorld: Beta",
      };
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-compact-3"),
          text: "Continue after compaction.",
          providerTurnOrdinal: 3,
          civilizationPacket: freshPacket,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 3, "post-compact Claude offer");
      assert.include(harness.offeredText(2), freshPacket.text);
      assert.include(harness.offeredText(2), "Continue after compaction.");
      assert.notInclude(harness.offeredText(2), packet.text);
      yield* offerClaudeResultAndSettle(harness, "claude-compact-r3", 3);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("injects the latest packet on an actionable prompt after resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeClaudePacketHarness();
      const now = yield* DateTime.now;
      const firstPacket: Packet = { revision: "rev-1", text: "CIVILIZATION PACKET rev-1" };
      const resumedPacket: Packet = { revision: "rev-2", text: "CIVILIZATION PACKET rev-2" };

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-resume-1"),
          text: "Before resume.",
          civilizationPacket: firstPacket,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 1, "pre-resume Claude offer");
      yield* offerClaudeResultAndSettle(harness, "claude-resume-r1", 1);

      yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-resume-2"),
          text: "After resume.",
          providerTurnOrdinal: 2,
          civilizationPacket: resumedPacket,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 2, "post-resume Claude offer");
      assert.include(harness.offeredText(1), resumedPacket.text);
      assert.notInclude(harness.offeredText(1), firstPacket.text);
      yield* offerClaudeResultAndSettle(harness, "claude-resume-r2", 2);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("injects the latest packet on a fork-equivalent actionable input", () =>
    Effect.gen(function* () {
      const harness = yield* makeClaudePacketHarness();
      const now = yield* DateTime.now;
      const packet: Packet = { revision: "rev-fork", text: "CIVILIZATION PACKET rev-fork" };
      const parentId = ThreadId.make("thread-claude-packet-parent");
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-fork-1"),
          text: "Forked Claude prompt.",
          civilizationPacket: packet,
          appThreadOverrides: {
            lineage: {
              parentThreadId: parentId,
              relationshipToParent: "fork",
              rootThreadId: parentId,
            },
          },
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 1, "fork Claude offer");
      assert.include(harness.offeredText(0), packet.text);
      assert.include(harness.offeredText(0), "Forked Claude prompt.");
      yield* offerClaudeResultAndSettle(harness, "claude-fork-r1", 1);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("injects the latest packet on a provider-switch-equivalent actionable input", () =>
    Effect.gen(function* () {
      const harness = yield* makeClaudePacketHarness();
      const now = yield* DateTime.now;
      const packet: Packet = {
        revision: "rev-switch",
        text: "CIVILIZATION PACKET rev-switch",
      };
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-provider-switch-1"),
          text: "First Claude prompt after provider switch.",
          civilizationPacket: packet,
        }),
      );
      yield* awaitUntil(() => harness.offeredMessages.length === 1, "provider-switch Claude offer");
      assert.lengthOf(
        harness.offeredMessages,
        1,
        "provider switch must not synthesize another prompt",
      );
      assert.include(harness.offeredText(0), packet.text);
      yield* offerClaudeResultAndSettle(harness, "claude-provider-switch-r1", 1);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );
});
