// @effect-diagnostics nodeBuiltinImport:off - local inference wire fixture for the real Kilo CLI.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ChatAttachmentId,
  CommandId,
  CheckpointId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import { describe } from "vite-plus/test";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { KiloSessionError } from "../../provider/kilo/KiloSessionClient.ts";
import * as KiloRuntime from "../../provider/kilo/KiloRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import type * as Adapter from "../ProviderAdapter.ts";
import * as KiloTextGeneration from "../../textGeneration/KiloTextGeneration.ts";
import * as KiloAdapter from "./KiloAdapterV2.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const binary = process.env.KILO_BIN;
const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
type RequestEvent = Extract<Adapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>;
const chunk = (choice: Record<string, unknown>, extra?: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "chatcmpl-local", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
/** A streamed completion that only calls one tool. */
const toolCall = (name: string, args: unknown) =>
  chunk({
    delta: {
      tool_calls: [
        {
          index: 0,
          id: `call_${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    finish_reason: null,
  }) +
  chunk({ delta: {}, finish_reason: "tool_calls" }) +
  "data: [DONE]\n\n";
const inference = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: Array<Record<string, unknown>> = [];
    const control: {
      mode: "text" | "approval" | "question" | "json" | "subagent" | "subagent-approval";
      json: string;
    } = {
      mode: "text",
      json: '{"title":"Local fixture title"}',
    };
    const server = NodeHttp.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        if (!parsed || !Array.isArray(parsed.messages)) {
          res.writeHead(400);
          res.end();
          return;
        }
        requests.push(parsed);
        if (parsed.stream !== true) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl-local",
              object: "chat.completion",
              created: 0,
              model: "test",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Local test" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const messages = parsed.messages as Array<{ role: string }>;
        if (
          (control.mode === "subagent" || control.mode === "subagent-approval") &&
          messages.at(-1)?.role !== "tool" &&
          !JSON.stringify(messages.at(-1) ?? null).includes("Child fixture reply")
        ) {
          res.end(
            toolCall("task", {
              description: "Local child",
              prompt: "Child fixture reply",
              subagent_type: "general",
            }),
          );
          return;
        }
        if (
          (control.mode === "approval" ||
            control.mode === "question" ||
            (control.mode === "subagent-approval" &&
              JSON.stringify(messages.at(-1)).includes("Child fixture reply"))) &&
          messages.at(-1)?.role !== "tool"
        ) {
          res.end(
            control.mode === "question"
              ? toolCall("question", {
                  questions: [
                    {
                      question: "Choose a color",
                      header: "Color",
                      multiple: true,
                      options: [
                        { label: "Blue", description: "Blue option" },
                        { label: "Red", description: "Red option" },
                      ],
                    },
                  ],
                })
              : toolCall("bash", {
                  command: "printf kilo-approved > approval.txt",
                  description: "Write the local approval fixture",
                }),
          );
          return;
        }
        if (control.mode === "text")
          res.write(
            chunk({ delta: { reasoning_content: "Fixture reasoning." }, finish_reason: null }),
          );
        for (const text of control.mode === "json"
          ? [control.json]
          : ["Hello ", "from ", "local Kilo."])
          res.write(chunk({ delta: { content: text }, finish_reason: null }));
        res.end(
          chunk(
            { delta: {}, finish_reason: "stop" },
            { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
          ) + "data: [DONE]\n\n",
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No inference address");
    return { server, requests, control, url: `http://127.0.0.1:${address.port}/v1` };
  }),
  ({ server }) =>
    Effect.promise(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
);

describe.skipIf(!binary)("Kilo adapter with native runtime and local inference", () => {
  it.live(
    "delivers a real streamed turn and restores its native history",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-adapter-" });
        // Both legacy MCP sources are trusted native config, even when project
        // discovery is disabled. The harmless fixture proves actual execution.
        for (const dir of [".kilo", ".kilocode"]) {
          yield* fs.makeDirectory(path.join(root, dir));
          const program = path.join(root, `${dir}-mcp.cjs`);
          yield* fs.writeFileString(
            program,
            `require('node:fs').writeFileSync(${encodeJson(path.join(root, `${dir}-marker`))}, String(process.pid));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[]}})+'\\n')});`,
          );
          yield* fs.writeFileString(
            path.join(root, dir, "mcp.json"),
            encodeJson({
              mcpServers: { [dir.slice(1)]: { command: process.execPath, args: [program] } },
            }),
          );
        }
        const model = yield* inference;
        const continuationKey = "account-scope";
        const instanceId = ProviderInstanceId.make("kilo-test");
        const threadId = ThreadId.make("kilo-thread");
        const modelSelection = { instanceId, model: "fixture/test", options: [] };
        const runtimePolicy = {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: root,
        };
        const runtime = yield* KiloRuntime.make({
          instanceId: continuationKey,
          binaryPath: binary!,
          profileDirectory: path.join(root, "profile"),
          processStateDirectory: path.join(root, "state"),
          environment: {
            PATH: process.env.PATH,
            HOME: root,
            HTTP_PROXY: process.env.HTTP_PROXY,
            HTTPS_PROXY: process.env.HTTPS_PROXY,
            NO_PROXY: process.env.NO_PROXY,
            NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
            KILO_DISABLE_AUTOUPDATE: "1",
            KILO_DISABLE_MODELS_FETCH: "1",
            KILO_DISABLE_DEFAULT_PLUGINS: "1",
            KILO_DISABLE_EXTERNAL_SKILLS: "1",
            KILO_DISABLE_PROJECT_CONFIG: "1",
            KILO_CONFIG_CONTENT: encodeJson({
              model: "fixture/test",
              small_model: "fixture/test",
              plugin: [],
              agent: { general: { permission: { bash: "ask" } } },
              provider: {
                fixture: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "Local fixture",
                  options: { baseURL: model.url },
                  models: { test: { name: "Test", limit: { context: 10000, output: 1000 } } },
                },
              },
            }),
          },
        });
        let dropInteraction = false;
        let droppedInteractions = 0;
        // Fault injection drops the transport before T3 sees a real pending native request.
        // All ownership checks, history, approvals and tool execution still use the actual CLI.
        const disconnectedRuntime = KiloRuntime.KiloRuntime.of({
          open: (directory) =>
            runtime.open(directory).pipe(
              Effect.map((connection) => ({
                ...connection,
                client: {
                  ...connection.client,
                  events: (...args: Parameters<typeof connection.client.events>) =>
                    connection.client.events(...args).pipe(
                      Stream.mapEffect((event) =>
                        Effect.suspend(() => {
                          if (
                            dropInteraction &&
                            (event.type === "permission.asked" || event.type === "question.asked")
                          ) {
                            dropInteraction = false;
                            droppedInteractions++;
                            return Effect.fail(
                              new KiloSessionError({
                                operation: "event.subscribe",
                                reason: "request_failed",
                              }),
                            );
                          }
                          return Effect.succeed(event);
                        }),
                      ),
                    ),
                },
              })),
            ),
        });
        const adapter = yield* KiloAdapter.make({
          instanceId,
          continuationKey,
          cwd: root,
          runtime: disconnectedRuntime,
          attachmentsDir: path.join(root, "attachments"),
        });
        const openAs = (name: string, kilo = adapter, thread = threadId) =>
          kilo.openSession({
            threadId: thread,
            providerSessionId: ProviderSessionId.make(name),
            modelSelection,
            runtimePolicy,
          });
        const session = yield* openAs("kilo-session");
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const seen: Adapter.ProviderAdapterV2Event[] = [];
        const questionShown = yield* Deferred.make<void>();
        let terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
        let interaction = yield* Deferred.make<RequestEvent>();
        yield* session.events.pipe(
          Stream.runForEach((event) => {
            seen.push(event);
            if (event.type === "turn_item.updated" && event.turnItem.type === "user_input_request")
              return Deferred.succeed(questionShown, undefined).pipe(Effect.asVoid);
            if (
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.status === "pending"
            )
              return Deferred.succeed(interaction, event).pipe(Effect.asVoid);
            return event.type === "turn.terminal"
              ? Deferred.succeed(terminal, event).pipe(Effect.asVoid)
              : Effect.void;
          }),
          Effect.forkScoped,
        );
        const now = yield* DateTime.now;
        const firstInput: Adapter.ProviderAdapterV2TurnInput = {
          appThread: {
            id: threadId,
            projectId: ProjectId.make("kilo-project"),
            title: "Local Kilo",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("kilo-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("kilo-attempt"),
          rootNodeId: NodeId.make("kilo-node"),
          providerThread,
          message: {
            messageId: MessageId.make("kilo-message"),
            text: "Say hello",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection,
          runtimePolicy,
        };
        yield* session.startTurn(firstInput);
        const result = yield* Deferred.await(terminal);
        assert.equal(result.type === "turn.terminal" ? result.status : undefined, "completed");
        const text = seen.findLast((event) => event.type === "message.updated");
        assert.equal(
          text?.type === "message.updated" ? text.message.text : undefined,
          "Hello from local Kilo.",
        );
        assert.isAbove(model.requests.length, 0);
        for (const dir of [".kilo", ".kilocode"])
          assert.isTrue(yield* fs.exists(path.join(root, `${dir}-marker`)));
        assert.isTrue(
          seen.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "reasoning"),
        );
        const restored = yield* session.readThreadSnapshot({ providerThread });
        assert.equal(restored.messages.at(-1)?.text, "Hello from local Kilo.");
        assert.deepEqual(
          restored.messages.map((m) => m.role),
          ["user", "assistant"],
        );
        assert.equal(restored.providerTurns.length, 1);
        assert.equal(restored.messages[0]!.id, firstInput.message.messageId);
        const restoredSession = yield* openAs("restored-session");
        const restoredThread = yield* restoredSession.resumeThread({
          providerThread: restored.providerThread,
        });
        const fromDisk = yield* restoredSession.readThreadSnapshot({
          providerThread: restoredThread,
        });
        assert.equal(fromDisk.providerTurns.length, 1);
        assert.equal(fromDisk.providerTurns[0]!.id, restored.providerTurns[0]!.id);
        assert.equal(fromDisk.messages[0]!.id, firstInput.message.messageId);
        assert.equal(fromDisk.messages[1]!.runId, firstInput.runId);
        assert.equal(
          DateTime.toEpochMillis(fromDisk.messages[0]!.createdAt),
          DateTime.toEpochMillis(restored.messages[0]!.createdAt),
        );

        terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
        yield* session.startTurn({
          ...firstInput,
          runId: RunId.make("second-run"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("second-attempt"),
          message: {
            ...firstInput.message,
            messageId: MessageId.make("second-message"),
            text: "Say hello again",
          },
        });
        // Delayed cancellation of turn one cannot stop turn two.
        yield* session.interruptTurn({
          providerThread,
          providerTurnId: restored.providerTurns[0]!.id,
        });
        const second = yield* Deferred.await(terminal);
        assert.equal(second.type === "turn.terminal" ? second.status : undefined, "completed");
        const secondHistory = yield* session.readThreadSnapshot({ providerThread });
        assert.equal(secondHistory.messages.length, 4);
        const fork = yield* session.forkThread({
          sourceProviderThread: providerThread,
          sourceProviderTurns: secondHistory.providerTurns,
          providerTurnId: restored.providerTurns[0]!.id,
          targetThreadId: ThreadId.make("fork-thread"),
        });
        const forkSession = yield* openAs("fork-session", adapter, ThreadId.make("fork-thread"));
        const forkThread = yield* forkSession.resumeThread({ providerThread: fork });
        const forkHistory = yield* forkSession.readThreadSnapshot({ providerThread: forkThread });
        assert.deepEqual(
          forkHistory.messages.map((m) => m.text),
          restored.messages.map((m) => m.text),
        );
        const rewound = yield* session.rollbackThread({
          providerThread,
          providerThreadTurns: secondHistory.providerTurns,
          target: {
            type: "provider_turn",
            providerTurn: restored.providerTurns[0]!,
            appRunOrdinal: 1,
            checkpointId: CheckpointId.make("rewind-checkpoint"),
          },
        });
        assert.equal(rewound.messages.length, 2);
        assert.equal(rewound.messages[0]!.id, firstInput.message.messageId);
        assert.equal(rewound.messages[1]!.runId, firstInput.runId);
        const rewindSession = yield* openAs("rewind-resume");
        const rewindThread = yield* rewindSession.resumeThread({
          providerThread: rewound.providerThread,
        });
        const rewindDisk = yield* rewindSession.readThreadSnapshot({
          providerThread: rewindThread,
        });
        assert.equal(rewindDisk.messages[0]!.id, firstInput.message.messageId);
        assert.equal(rewindDisk.providerTurns[0]!.id, restored.providerTurns[0]!.id);
        assert.notEqual(
          rewound.providerTurns[0]!.nativeTurnRef?.nativeId,
          restored.providerTurns[0]!.nativeTurnRef?.nativeId,
        );
        // The source ref is stale after rewind and cannot mutate the replacement conversation.
        yield* session.startTurn(firstInput).pipe(Effect.flip);
        const empty = yield* session.rollbackThread({
          providerThread: rewound.providerThread,
          providerThreadTurns: rewound.providerTurns,
          target: {
            type: "thread_start",
            appRunOrdinal: 0,
            checkpointId: CheckpointId.make("start-checkpoint"),
          },
        });
        assert.equal(empty.messages.length, 0);
        for (const decision of ["decline", "accept"] as const) {
          terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
          interaction = yield* Deferred.make<RequestEvent>();
          model.control.mode = "approval";
          yield* session.startTurn({
            ...firstInput,
            providerThread: empty.providerThread,
            runtimePolicy: { ...runtimePolicy, runtimeMode: "approval-required" },
            message: { ...firstInput.message, text: "Run the approval fixture" },
          });
          const pending = yield* Deferred.await(interaction);
          assert.equal(yield* fs.exists(path.join(root, "approval.txt")), false);
          yield* session.respondToRuntimeRequest({
            requestId: pending.runtimeRequest.id,
            decision,
          });
          yield* Deferred.await(terminal);
          assert.equal(yield* fs.exists(path.join(root, "approval.txt")), decision === "accept");
        }
        terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
        interaction = yield* Deferred.make<RequestEvent>();
        dropInteraction = true;
        model.control.mode = "question";
        yield* session.startTurn({
          ...firstInput,
          providerThread: empty.providerThread,
          message: { ...firstInput.message, text: "Ask the question fixture" },
        });
        const question = yield* Deferred.await(interaction);
        assert.equal(question.runtimeRequest.kind, "user_input");
        assert.equal(droppedInteractions, 1);
        yield* Deferred.await(questionShown);
        const questionItem = seen.findLast(
          (e) => e.type === "turn_item.updated" && e.turnItem.type === "user_input_request",
        );
        assert.isTrue(
          questionItem?.type === "turn_item.updated" &&
            questionItem.turnItem.type === "user_input_request" &&
            questionItem.turnItem.questions[0]?.multiSelect,
        );
        // Kilo Question.Prompt permits multiple but native Info defaults custom to true.
        assert.isTrue(
          questionItem?.type === "turn_item.updated" &&
            questionItem.turnItem.type === "user_input_request" &&
            questionItem.turnItem.questions[0]?.allowCustomAnswer,
        );
        yield* session.respondToRuntimeRequest({
          requestId: question.runtimeRequest.id,
          answers: { "0": ["Blue", "Red"] },
        });
        yield* Deferred.await(terminal);
        const requestNodes = new Map(
          seen
            .filter(
              (event) =>
                event.type === "node.updated" &&
                (event.node.kind === "approval_request" ||
                  event.node.kind === "user_input_request"),
            )
            .map((event) => [event.type === "node.updated" ? event.node.id : "", event]),
        );
        assert.isAbove(requestNodes.size, 0);
        for (const event of requestNodes.values())
          assert.equal(event.type === "node.updated" ? event.node.status : undefined, "completed");
        model.control.mode = "subagent";
        terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
        yield* session.startTurn({
          ...firstInput,
          providerThread: empty.providerThread,
          message: { ...firstInput.message, text: "Delegate the local child fixture" },
        });
        yield* Deferred.await(terminal);
        const children = seen.filter((event) => event.type === "subagent.updated");
        assert.isTrue(children.some((event) => event.subagent.status === "running"));
        const child = children.findLast((event) => event.subagent.status === "completed");
        assert.isDefined(child?.subagent.childThreadId);
        assert.isTrue(
          seen.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.threadId === child?.subagent.childThreadId &&
              event.message.text.includes("Hello from local Kilo"),
          ),
        );
        for (const restrictedPolicy of [
          { ...runtimePolicy, runtimeMode: "approval-required" as const },
          { ...runtimePolicy, approvalPolicy: "on-request" },
          { ...runtimePolicy, interactionMode: "plan" as const },
        ]) {
          terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
          const before = seen.length;
          yield* session.startTurn({
            ...firstInput,
            providerThread: empty.providerThread,
            runtimePolicy: restrictedPolicy,
            message: {
              ...firstInput.message,
              messageId: MessageId.make(`restricted-${before}`),
              text: "Delegate the local child fixture",
            },
          });
          const ended = yield* Deferred.await(terminal);
          assert.equal(ended.type === "turn.terminal" ? ended.status : undefined, "completed");
          assert.isFalse(seen.slice(before).some((event) => event.type === "app_thread.created"));
        }
        model.control.mode = "json";
        const textGeneration = yield* KiloTextGeneration.make().pipe(
          Effect.provideService(KiloRuntime.KiloRuntime, runtime),
        );
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: root,
          modelSelection,
          message: "Name this test thread",
        });
        assert.equal(generated.title, "Local fixture title");
        model.control.json = '{"branch":"  Local Kilo  "}';
        const branch = yield* textGeneration.generateBranchName({
          cwd: root,
          modelSelection,
          message: "Add the local Kilo provider",
        });
        assert.equal(branch.branch, "local-kilo");
        model.control.json =
          '{"subject":"feat: add local Kilo","body":"  Connect the native runtime.  ","branch":"local-kilo"}';
        const commit = yield* textGeneration.generateCommitMessage({
          cwd: root,
          modelSelection,
          branch: "main",
          stagedSummary: "1 file changed",
          stagedPatch: "+local Kilo provider",
          includeBranch: true,
        });
        assert.deepEqual(commit, {
          subject: "feat: add local Kilo",
          body: "Connect the native runtime.",
          branch: "feature/local-kilo",
        });
        model.control.json =
          '{"title":"feat: add local Kilo","body":"  Add an isolated native runtime.  "}';
        const pr = yield* textGeneration.generatePrContent({
          cwd: root,
          modelSelection,
          baseBranch: "main",
          headBranch: "local-kilo",
          commitSummary: "feat: add local Kilo",
          diffSummary: "1 file changed",
          diffPatch: "+local Kilo provider",
        });
        assert.deepEqual(pr, {
          title: "feat: add local Kilo",
          body: "Add an isolated native runtime.",
        });
        // Native text may be valid JSON without satisfying the requested output schema.
        // Reject it at the Kilo boundary rather than handing malformed results to T3.
        const malformed = yield* textGeneration
          .generateBranchName({ cwd: root, modelSelection, message: "Name the branch" })
          .pipe(Effect.flip);
        assert.equal(malformed.operation, "generateBranchName");
        model.control.mode = "text";
        const workspace = path.join(root, "integration-workspace");
        yield* fs.makeDirectory(workspace);
        yield* fs.writeFileString(path.join(workspace, "README.md"), "Kilo integration fixture\n");
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        for (const args of [
          ["init"],
          ["add", "README.md"],
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "fixture",
          ],
        ]) {
          const process = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: workspace }));
          assert.equal(Number(yield* process.exitCode), 0);
        }
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const appThreadId = ThreadId.make("orchestrated-kilo-thread");
          const done = yield* Deferred.make<void>();
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.runForEach(({ event }) =>
              event.threadId === appThreadId &&
              event.type === "run.updated" &&
              ["completed", "failed", "interrupted"].includes(event.payload.status)
                ? Deferred.succeed(done, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("kilo-create"),
            createdBy: "user",
            creationSource: "web",
            threadId: appThreadId,
            projectId: ProjectId.make("kilo-orchestration-project"),
            title: "Kilo integrated",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspace,
          });
          const attachment = {
            type: "file" as const,
            id: ChatAttachmentId.make("kilo-fixture"),
            name: "fixture.txt",
            mimeType: "text/plain",
            sizeBytes: 7,
          };
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: path.join(root, "attachments"),
            attachment,
          });
          if (!attachmentPath) throw new Error("Invalid fixture attachment path");
          yield* fs.makeDirectory(path.dirname(attachmentPath), { recursive: true });
          yield* fs.writeFileString(attachmentPath, "fixture");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("kilo-send"),
            createdBy: "user",
            creationSource: "web",
            threadId: appThreadId,
            messageId: MessageId.make("orchestrated-user-message"),
            text: "Hello through Orchestrator V2",
            attachments: [attachment],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const startedProjection = yield* orchestrator.getThreadProjection(appThreadId);
          assert.isAbove(startedProjection.runs.length, 0, encodeJson(startedProjection));
          yield* Deferred.await(done);
          const projection = yield* orchestrator.getThreadProjection(appThreadId);
          assert.equal(projection.runs[0]?.status, "completed");
          assert.equal(projection.providerThreads.length, 1);
          const userMessage = projection.messages.find((m) => m.id === "orchestrated-user-message");
          assert.deepEqual(userMessage?.attachments, [attachment]);
          assert.equal(userMessage?.text, "Hello through Orchestrator V2");
          assert.equal(userMessage?.creationSource, "web");
          assert.deepEqual(
            projection.messages.filter((m) => m.role === "user").map((m) => m.id),
            ["orchestrated-user-message"],
          );
          assert.isTrue(
            projection.turnItems.some(
              (item) =>
                item.type === "assistant_message" &&
                item.text === "Hello from local Kilo." &&
                !item.streaming,
            ),
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "kilo-native-integration" },
              ProviderAdapterRegistry.layerSingle(adapter),
            ),
          ),
        );
        for (const action of ["accept", "stop"] as const) {
          yield* fs.remove(path.join(root, "approval.txt"), { force: true });
          dropInteraction = action === "accept";
          model.control.mode = "subagent-approval";
          terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
          interaction = yield* Deferred.make<RequestEvent>();
          const startIndex = seen.length;
          yield* session.startTurn({
            ...firstInput,
            providerThread: empty.providerThread,
            runtimePolicy,
            message: {
              ...firstInput.message,
              messageId: MessageId.make(`child-${action}`),
              text: "Delegate the local child fixture",
            },
          });
          const pending = yield* Effect.raceFirst(
            Deferred.await(interaction),
            Deferred.await(terminal).pipe(
              Effect.flatMap((event) =>
                Effect.die(
                  new Error(
                    encodeJson({ unexpectedTerminal: event, events: seen.slice(startIndex) }),
                  ),
                ),
              ),
            ),
          );
          assert.equal(pending.runtimeRequest.kind, "command");
          assert.equal(droppedInteractions, 2);
          assert.isFalse(yield* fs.exists(path.join(root, "approval.txt")));
          const started = seen
            .slice(startIndex)
            .find((e) => e.type === "provider_turn.updated" && e.providerTurn.status === "running");
          if (started?.type !== "provider_turn.updated") throw new Error("No active native turn");
          if (action === "accept") {
            yield* session.respondToRuntimeRequest({
              requestId: pending.runtimeRequest.id,
              decision: "accept",
            });
          } else {
            yield* session.interruptTurn({
              providerThread: empty.providerThread,
              providerTurnId: started.providerTurn.id,
            });
          }
          const ended = yield* Deferred.await(terminal);
          assert.equal(
            ended.type === "turn.terminal" ? ended.status : undefined,
            action === "accept" ? "completed" : "interrupted",
          );
          assert.equal(yield* fs.exists(path.join(root, "approval.txt")), action === "accept");
          if (action === "stop") {
            const childStates = new Map(
              seen
                .slice(startIndex)
                .filter((e) => e.type === "subagent.updated")
                .map((e) => [e.subagent.id, e.subagent.status]),
            );
            assert.isAbove(childStates.size, 0);
            assert.isTrue([...childStates.values()].every((status) => status !== "running"));
            yield* session
              .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
              .pipe(Effect.flip);
            yield* session
              .startTurn({ ...firstInput, providerThread: empty.providerThread })
              .pipe(Effect.flip);
            const saved = seen
              .slice(startIndex)
              .findLast(
                (e) =>
                  e.type === "provider_thread.updated" &&
                  e.providerThread.id === empty.providerThread.id,
              );
            if (saved?.type !== "provider_thread.updated")
              throw new Error("Missing durable interruption metadata");
            const fresh = yield* openAs("after-stop");
            const resumed = yield* fresh.resumeThread({ providerThread: saved.providerThread });
            const history = yield* fresh.readThreadSnapshot({ providerThread: resumed });
            assert.equal(
              history.providerTurns.find((turn) => turn.id === started.providerTurn.id)?.status,
              "interrupted",
            );
            const invalidAgentDone = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
            yield* fresh.events.pipe(
              Stream.runForEach((event) =>
                event.type === "turn.terminal"
                  ? Deferred.succeed(invalidAgentDone, event).pipe(Effect.asVoid)
                  : Effect.void,
              ),
              Effect.forkScoped,
            );
            yield* fresh.startTurn({
              ...firstInput,
              providerThread: resumed,
              modelSelection: {
                ...modelSelection,
                options: [{ id: "agent", value: "missing-kilo-fixture-agent" }],
              },
              message: {
                ...firstInput.message,
                messageId: MessageId.make("missing-agent-message"),
                text: "Fail before creating an assistant",
              },
            });
            const invalidAgent = yield* Deferred.await(invalidAgentDone);
            assert.equal(
              invalidAgent.type === "turn.terminal" ? invalidAgent.status : undefined,
              "failed",
            );
          }
        }
        const otherAccount = yield* KiloAdapter.make({
          instanceId,
          continuationKey: "different-account",
          cwd: root,
          runtime,
        });
        const otherSession = yield* openAs("other", otherAccount);
        yield* otherSession.resumeThread({ providerThread }).pipe(Effect.flip);
        yield* otherSession
          .ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
            existingProviderThread: { ...restored.providerThread, nativeThreadRef: null },
          })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    { timeout: 120000 },
  );
});
