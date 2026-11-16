import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

const replayTurn = (id: string, status: "inProgress" | "completed") => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1782622440,
  completedAt: status === "completed" ? 1782622450 : null,
  durationMs: null,
});

/** One turn: Codex reads its config before each `turn/start`, and the turn sends `sentPrompt`. */
const oneTurnTranscript = (input: {
  readonly scenario: string;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly sentPrompt: string;
}): CodexReplay.CodexAppServerReplayTranscript => ({
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.144.0",
  scenario: input.scenario,
  entries: [
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
            projectId: null,
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
    {
      type: "expect_outbound",
      label: "config/read",
      frame: { id: 3, method: "config/read", params: { cwd: "/workspace", includeLayers: false } },
    },
    {
      type: "emit_inbound",
      label: "config/read",
      frame: { id: 3, result: { config: {}, origins: {} } },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 4,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "auto",
          collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: { id: 4, result: { turn: replayTurn(input.nativeTurnId, "inProgress") } },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: replayTurn(input.nativeTurnId, "inProgress"),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: input.nativeThreadId,
          turn: replayTurn(input.nativeTurnId, "completed"),
        },
      },
    },
  ],
});

it.effect("sends a skill as `$name` only from the user's own text, not from inline context", () =>
  Effect.gen(function* () {
    const context = "<fyi>Try €lint first.</fyi>\n\nUser message:\n";
    const transcript = oneTurnTranscript({
      scenario: "skill-sigil",
      nativeThreadId: "skill-sigil-thread",
      nativeTurnId: "skill-sigil-turn",
      sentPrompt: `${context}$review the plan`,
    });
    const replayDriver = yield* CodexReplay.makeReplayDriver(transcript, {});
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory: {
        open: (openInput) =>
          Layer.build(CodexReplay.layerReplayWithDriver(replayDriver)).pipe(
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
                Effect.provide(context),
              ),
            ),
          ),
      },
      digest: yield* Digest.Digest,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(transcript.scenario).pipe(
        Effect.orDie,
      ),
      continuationRequests: { offer: () => Effect.void },
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection: MODEL_SELECTION,
      runtimePolicy: RUNTIME_POLICY,
      promptSuggestions: Effect.succeed(false),
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: MODEL_SELECTION,
      runtimePolicy: RUNTIME_POLICY,
    });
    const firstTerminal = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        event.type === "turn.terminal" ? Deferred.succeed(firstTerminal, undefined) : Effect.void,
      ),
      Effect.forkScoped,
    );
    const now = yield* DateTime.now;
    const attemptId = RunAttemptId.make("skill-sigil-attempt");
    yield* runtime.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project-${threadId}`),
        title: "Codex continuation test",
        providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-${attemptId}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId,
      rootNodeId: NodeId.make(`node-${attemptId}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-${attemptId}`),
        text: `${context}€review the plan`,
        attachments: [],
      },
      modelSelection: MODEL_SELECTION,
      runtimePolicy: RUNTIME_POLICY,
      inlineContextLength: context.length,
    });
    yield* Deferred.await(firstTerminal);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);
