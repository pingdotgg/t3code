// @effect-diagnostics nodeBuiltinImport:off - external customer API contract over a loopback socket.
import * as NodeChildProcess from "node:child_process";
import * as KiloRuntime from "../../provider/kilo/KiloRuntime.ts";
import * as KiloAdapter from "./KiloAdapterV2.ts";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as Account from "../../provider/kilo/KiloCloudAccount.ts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import { NodeId, ProviderDriverKind } from "@t3tools/contracts";
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Cloud from "../../provider/kilo/KiloCloudWebClient.ts";
import * as Journal from "../../provider/kilo/KiloCloudJournal.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import type * as Adapter from "../ProviderAdapter.ts";
import * as CloudAdapter from "./KiloCloudAdapterV2.ts";

const clockAt = (clock: Clock.Clock, millis: number): Clock.Clock => ({
  ...clock,
  currentTimeMillis: Effect.succeed(millis),
  currentTimeMillisUnsafe: () => millis,
  currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
  sleep: clock.sleep.bind(clock),
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeIntent = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(Journal.CloudIntent)),
);
const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    let submissions = 0;
    let localResponse: NodeHttp.ServerResponse | undefined;
    let localRequests = 0;
    let overlapped = false;
    const completeLocal = () => {
      if (
        !localResponse ||
        localResponse.destroyed ||
        localResponse.writableEnded ||
        submissions < 2
      )
        return;
      overlapped = true;
      localResponse.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [
        { delta: { role: "assistant", content: "Local parallel reply" }, finish_reason: null },
        { delta: {}, finish_reason: "stop" },
      ])
        localResponse.write(
          `data: ${JSON.stringify({ id: "chatcmpl-parallel", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...choice }] })}\n\n`,
        );
      localResponse.end("data: [DONE]\n\n");
      localResponse = undefined;
    };
    let signalInterrupt!: () => void;
    const interruptSeen = new Promise<void>((resolve) => {
      signalInterrupt = resolve;
    });
    const control = {
      prepareStatus: 200,
      parkPrepare: false,
      parkedPrepare: undefined as NodeHttp.ServerResponse | undefined,
      prepareSeen: undefined as (() => void) | undefined,
      preparePosts: 0,
      listReads: 0,
      listStatus: 200,
      parkList: false,
      parkedList: undefined as NodeHttp.ServerResponse | undefined,
      listSeen: undefined as (() => void) | undefined,
      listClosed: undefined as (() => void) | undefined,
      resultReads: 0,
      completeAfterResultReads: 0,
      sessionStatus: 200,
      sessionBranch: "main",
      malformedSession: false,
      sendPosts: 0,
      parkSend: false,
      parkedSend: undefined as NodeHttp.ServerResponse | undefined,
      sendSeen: undefined as (() => void) | undefined,
      profileStatus: 200,
      personalAccount: true,
      profileAccount: "fixture-account",
      malformedProfile: false,
      preflightStatus: 200,
      malformedPreflight: false,
      afterBindings: undefined as (() => void) | undefined,
      parkedPreflight: undefined as NodeHttp.ServerResponse | undefined,
      parkPreflight: false,
      preflightSeen: undefined as (() => void) | undefined,
      status: "completed",
      requireLocalOverlap: false,
      dropNextPrepare: false,
      hideAdmissions: false,
      omittedItemCount: 0,
      missingHistory: false,
      incompleteHistory: false,
      historyMode: "normal",
      historyReads: 0,
      interruptAccepted: false,
      interruptPosts: 0,
      permission: false,
      question: false,
      questionPosts: 0,
      questionAnswers: null as unknown,
      answerAccepted: false,
      answerPosts: 0,
    };
    const conversations = new Map<
      string,
      {
        cloud: string;
        native: string;
        worktree: string;
        initial: string;
        messages: Array<{ id: string; prompt: string }>;
      }
    >();
    const server = NodeHttp.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        const url = new URL(request.url!, "http://localhost");
        if (url.pathname.endsWith("/chat/completions")) {
          localRequests++;
          localResponse = response;
          response.once("close", () => {
            if (localResponse === response) localResponse = undefined;
          });
          response.on("error", () => {
            if (localResponse === response) localResponse = undefined;
          });
          completeLocal();
          return;
        }
        const operation = url.pathname.split("/").at(-1)!;
        const input = JSON.parse(raw || url.searchParams.get("input") || "{}") as Record<
          string,
          string
        >;
        const reply = (data: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ result: { data } }));
        };
        if (url.pathname === "/api/profile") {
          response.writeHead(control.profileStatus, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              control.malformedProfile
                ? {}
                : {
                    user: { id: control.profileAccount },
                    hasPersonalAccount: control.personalAccount,
                  },
            ),
          );
          return;
        }
        if (operation.startsWith("agentProfiles.")) {
          if (control.parkPreflight) {
            control.parkedPreflight = response;
            response.once("close", () => {
              if (control.parkedPreflight === response) control.parkedPreflight = undefined;
            });
            control.preflightSeen?.();
            return;
          }
          if (control.preflightStatus !== 200) {
            response.writeHead(control.preflightStatus);
            response.end();
            return;
          }
          if (operation.endsWith("listRepoBindings")) control.afterBindings?.();
          return reply(control.malformedPreflight ? {} : []);
        }
        if (operation === "cloudAgentNext.prepareSession") {
          control.preparePosts++;
          if (control.parkPrepare) {
            control.parkedPrepare = response;
            response.once("close", () => {
              if (control.parkedPrepare === response) control.parkedPrepare = undefined;
            });
            response.on("error", () => {});
            control.prepareSeen?.();
            return;
          }
          if (control.prepareStatus !== 200) {
            response.writeHead(control.prepareStatus);
            response.end();
            return;
          }
          submissions++;
          completeLocal();
          const suffix = String(submissions).padStart(12, "0");
          const state = {
            cloud: `workspace_12345678-1234-1234-1234-${suffix}`,
            native: `ses_fixture${submissions}`,
            worktree: `worktree_12345678-1234-1234-1234-${suffix}`,
            initial: input.initialMessageId!,
            messages: [{ id: input.initialMessageId!, prompt: input.prompt! }],
          };
          conversations.set(state.cloud, state);
          if (control.dropNextPrepare) {
            control.dropNextPrepare = false;
            response.destroy();
            return;
          }
          return reply({ cloudAgentSessionId: state.cloud, kiloSessionId: state.native });
        }
        if (operation === "cliSessionsV2.list") control.listReads++;
        if (operation === "cliSessionsV2.list" && control.parkList) {
          control.parkedList = response;
          response.once("close", () => {
            if (control.parkedList === response) control.parkedList = undefined;
            control.listClosed?.();
          });
          response.on("error", () => {});
          control.listSeen?.();
          return;
        }
        if (operation === "cliSessionsV2.list" && control.listStatus !== 200) {
          response.writeHead(control.listStatus);
          response.end();
          return;
        }
        if (operation === "cliSessionsV2.list")
          return reply({
            cliSessions: (control.hideAdmissions ? [] : [...conversations.values()]).map(
              (state) => ({
                session_id: state.native,
                cloud_agent_session_id: state.cloud,
              }),
            ),
            nextCursor: null,
          });
        const state = [...conversations.values()].find(
          (item) => item.cloud === input.cloudAgentSessionId || item.native === input.session_id,
        );
        if (operation === "cloudAgentNext.interruptSession") {
          control.interruptPosts++;
          signalInterrupt();
          if (control.interruptAccepted) control.status = "interrupted";
          return reply({ success: control.interruptAccepted });
        }
        if (operation === "cloudAgentNext.answerQuestion") {
          control.questionPosts++;
          control.questionAnswers = input.answers;
          control.question = false;
          return reply({ success: true });
        }
        if (operation === "cloudAgentNext.answerPermission") {
          control.answerPosts++;
          if (control.answerAccepted) control.permission = false;
          return reply({ success: control.answerAccepted });
        }
        if (!state) {
          response.writeHead(404);
          response.end();
          return;
        }
        if (operation === "cloudAgentNext.getSession" && control.sessionStatus !== 200) {
          response.writeHead(control.sessionStatus);
          response.end();
          return;
        }
        if (operation === "cloudAgentNext.getSession" && control.malformedSession) return reply({});
        if (operation === "cloudAgentNext.getSession")
          return reply({
            sessionId: state.cloud,
            kiloSessionId: state.native,
            worktreeId: state.worktree,
            userId: "fixture-account",
            githubRepo: "fixture/repo",
            upstreamBranch: control.sessionBranch,
            autoCommit: false,
            initialMessageId: state.initial,
            execution: null,
          });
        if (operation === "cloudAgentNext.sendMessage") {
          control.sendPosts++;
          if (control.parkSend) {
            control.parkedSend = response;
            response.once("close", () => {
              control.parkedSend = undefined;
            });
            response.on("error", () => {});
            control.sendSeen?.();
            return;
          }
          const payload = input.payload as unknown as { prompt: string };
          state.messages.push({ id: input.messageId!, prompt: payload.prompt });
          return reply({
            cloudAgentSessionId: state.cloud,
            messageId: input.messageId,
            status: "started",
            delivery: "sent",
          });
        }
        if (operation === "cloudAgentNext.getPendingInteractions")
          return reply({
            permissions: control.permission
              ? [
                  {
                    id: "permission-fixture",
                    sessionID: state.native,
                    permission: "read",
                    patterns: ["README.md"],
                  },
                ]
              : [],
            questions: control.question
              ? [
                  {
                    id: "question-fixture",
                    sessionID: state.native,
                    questions: [
                      {
                        header: "Files",
                        question: "Which files?",
                        multiple: true,
                        custom: false,
                        options: [
                          { label: "README.md", description: "Documentation" },
                          { label: "fixture.py", description: "Synthetic code" },
                        ],
                      },
                    ],
                  },
                ]
              : [],
          });
        if (operation === "cloudAgentNext.getSandboxStatus")
          return reply({
            status: control.status === "running" ? "active" : "sleeping",
            observedAt: 1,
            inactivityTimeoutMs: null,
            estimatedSleepAt: null,
          });
        if (operation === "cloudAgentNext.getComputeBillingStatus")
          return reply({
            phase: control.status === "running" ? "active" : "idle",
            attribution: "session",
            estimatedHourlyRateMicrodollars: 0,
            estimatedIntervalAmountMicrodollars: 0,
          });
        if (operation === "cloudAgentNext.getMessageResult") control.resultReads++;
        if (operation === "cloudAgentNext.getMessageResult")
          return reply({
            cloudAgentSessionId: state.cloud,
            messageId: input.messageId,
            status:
              control.completeAfterResultReads > 0
                ? control.resultReads >= control.completeAfterResultReads
                  ? "completed"
                  : "running"
                : control.requireLocalOverlap && !localRequests
                  ? "running"
                  : control.status,
          });
        if (operation === "cliSessionsV2.getSessionMessagesPage") control.historyReads++;
        if (operation === "cliSessionsV2.getSessionMessagesPage" && control.missingHistory)
          return reply({ kiloSessionId: state.native, history: null, watermarkEventId: 49 });
        if (
          operation === "cliSessionsV2.getSessionMessagesPage" &&
          control.historyMode !== "normal"
        ) {
          const message =
            control.historyMode === "older" && input.cursor === "1"
              ? state.messages[0]!
              : state.messages.at(-1)!;
          const part = {
            id: `tool-${message.id}`,
            sessionID: state.native,
            messageID: `reply-${message.id}`,
            type: "tool",
            tool: "read",
            callID: `call-${message.id}`,
            state: { status: "completed", input: {}, output: "synthetic" },
          };
          const assistant = {
            info: {
              id: `reply-${message.id}`,
              sessionID: state.native,
              role: "assistant",
              parentID: message.id,
              time: { created: 1, completed: 2 },
            },
            parts: control.historyMode === "empty" ? [] : [part],
          };
          const user = {
            info: { id: message.id, sessionID: state.native, role: "user", time: { created: 1 } },
            parts: [],
          };
          const page = Number(input.cursor ?? 0);
          const more = control.historyMode === "paged" && page < 4;
          return reply({
            kiloSessionId: state.native,
            watermarkEventId: 3,
            history: {
              nextCursor:
                control.historyMode === "repeated" ||
                (control.historyMode === "older" && !input.cursor)
                  ? "1"
                  : more
                    ? String(page + 1)
                    : null,
              omittedItemCount: 0,
              messages: more
                ? []
                : [
                    assistant,
                    ...(control.historyMode === "unfinished"
                      ? [
                          {
                            info: {
                              ...assistant.info,
                              id: `newer-${message.id}`,
                              time: { created: 3 },
                            },
                            parts: [
                              {
                                ...part,
                                id: `newer-tool-${message.id}`,
                                messageID: `newer-${message.id}`,
                                state: { status: "running", input: {} },
                              },
                            ],
                          },
                        ]
                      : []),
                    ...(control.historyMode === "repeated" ? [] : [user]),
                  ],
            },
          });
        }
        if (operation === "cliSessionsV2.getSessionMessagesPage")
          return reply({
            kiloSessionId: state.native,
            watermarkEventId: 3,
            history: {
              nextCursor: null,
              omittedItemCount: control.omittedItemCount,
              messages: state.messages.flatMap((message) => [
                {
                  info: {
                    id: message.id,
                    sessionID: state.native,
                    role: "user",
                    time: { created: 1 },
                  },
                  parts: [
                    {
                      id: `part-${message.id}`,
                      messageID: message.id,
                      sessionID: state.native,
                      type: "text",
                      text: message.prompt,
                    },
                  ],
                },
                {
                  info: {
                    id: `reply-${message.id}`,
                    sessionID: state.native,
                    role: "assistant",
                    finish: "stop",
                    parentID: message.id,
                    time:
                      control.incompleteHistory && message !== state.messages[0]
                        ? { created: 2 }
                        : { created: 2, completed: 3 },
                  },
                  parts: [
                    {
                      id: `part-reply-${message.id}`,
                      messageID: `reply-${message.id}`,
                      sessionID: state.native,
                      type: "text",
                      text: `Remote reply: ${message.prompt}`,
                    },
                  ],
                },
              ]),
            },
          });
        response.writeHead(400);
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    return {
      origin: `http://127.0.0.1:${address.port}`,
      submissions: () => submissions,
      localRequests: () => localRequests,
      overlapped: () => overlapped,
      conversations,
      control,
      interruptSeen,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }),
  (fixture) => Effect.promise(fixture.close),
);

it.live(
  "completes two isolated cloud threads through SQLite orchestration without touching local workspaces",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      remote.control.dropNextPrepare = true;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const journal = yield* Journal.make(directory);
      const instanceId = ProviderInstanceId.make("cloud-test");
      const modelSelection = { instanceId, model: "fixture/model" };
      let restore: Adapter.ProviderAdapterV2TurnInput | undefined;
      const adapterOptions = {
        instanceId,
        continuationKey: "fixture-account-repo",
        accountId: "fixture-account",
        repository: "fixture/repo",
        branch: "main",
        client: Cloud.make({
          accountId: "fixture-account",
          token: Redacted.make("fixture-token"),
          origin: remote.origin,
        }),
        journal,
      };
      const adapter = yield* CloudAdapter.make(adapterOptions);
      const localInstance = ProviderInstanceId.make("native-parallel");
      const localSelection = { instanceId: localInstance, model: "fixture/test" };
      const localCwd = `${directory}/local`;
      let localAdapter: Adapter.ProviderAdapterV2Shape | undefined;
      if (process.env.KILO_BIN) {
        remote.control.requireLocalOverlap = true;
        yield* fs.makeDirectory(localCwd);
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              NodeChildProcess.execFile("git", ["init", "--quiet", localCwd], (error) =>
                error ? reject(error) : resolve(),
              ),
            ),
        );
        const native = yield* KiloRuntime.make({
          instanceId: "native-parallel",
          binaryPath: process.env.KILO_BIN,
          profileDirectory: `${directory}/native-profile`,
          environment: {
            PATH: process.env.PATH,
            HOME: directory,
            KILO_DISABLE_MODELS_FETCH: "1",
            KILO_DISABLE_DEFAULT_PLUGINS: "1",
            KILO_DISABLE_EXTERNAL_SKILLS: "1",
            KILO_CONFIG_CONTENT: yield* encodeJson({
              model: "fixture/test",
              small_model: "fixture/test",
              plugin: [],
              provider: {
                fixture: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "Loopback",
                  options: { baseURL: `${remote.origin}/v1` },
                  models: { test: { name: "Test", limit: { context: 10000, output: 1000 } } },
                },
              },
            }),
          },
        });
        localAdapter = yield* KiloAdapter.make({
          instanceId: localInstance,
          continuationKey: "native-parallel",
          cwd: localCwd,
          attachmentsDir: `${directory}/attachments`,
          runtime: native,
        });
      }
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const done = yield* Deferred.make<void>();
        const completed = new Set<string>();
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.runForEach(({ event }) => {
            if (
              event.type === "run.updated" &&
              ["completed", "failed", "interrupted"].includes(event.payload.status)
            )
              completed.add(event.threadId);
            return completed.size === (localAdapter ? 3 : 2)
              ? Deferred.succeed(done, undefined).pipe(Effect.asVoid)
              : Effect.void;
          }),
          Effect.forkScoped,
        );
        for (const suffix of [...(localAdapter ? ["local"] : []), "a", "b"]) {
          const selectedModel = suffix === "local" ? localSelection : modelSelection;
          const threadId = ThreadId.make(`cloud-${suffix}`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${suffix}`),
            createdBy: "user",
            creationSource: "web",
            threadId,
            projectId: ProjectId.make("cloud-project"),
            title: "Cloud contract",
            modelSelection: selectedModel,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: suffix === "local" ? localCwd : `${directory}/must-not-exist-${suffix}`,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send-${suffix}`),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make(`user-${suffix}`),
            text: `isolation-${suffix}`,
            attachments: [],
            modelSelection: selectedModel,
            dispatchMode: { type: "start_immediately" },
          });
        }
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        yield* Deferred.await(done);
        if (localAdapter) {
          assert.isTrue(remote.overlapped());
          assert.isAbove(remote.localRequests(), 0);
          const projection = yield* orchestrator.getThreadProjection(ThreadId.make("cloud-local"));
          assert.equal(
            projection.runs[0]?.status,
            "completed",
            yield* encodeJson(projection.turnItems),
          );
          assert.isTrue(
            projection.messages.some((message) => message.text === "Local parallel reply"),
          );
          assert.isFalse(
            projection.messages.some((message) => message.text.includes("Remote reply")),
          );
        }
        for (const suffix of ["a", "b"]) {
          const projection = yield* orchestrator.getThreadProjection(
            ThreadId.make(`cloud-${suffix}`),
          );
          assert.equal(
            projection.runs[0]?.status,
            "completed",
            yield* encodeJson(projection.turnItems),
          );
          assert.isNotNull(projection.runs[0]?.completedAt);
          assert.isTrue(
            projection.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.text === `Remote reply: isolation-${suffix}`,
            ),
          );
          assert.isFalse(
            projection.messages.some((message) =>
              message.text.includes(`isolation-${suffix === "a" ? "b" : "a"}`),
            ),
          );
          assert.isFalse(yield* fs.exists(`${directory}/must-not-exist-${suffix}`));
          assert.equal(projection.checkpoints.length, 0);
          if (suffix === "a") {
            const run = projection.runs[0];
            const providerThread = projection.providerThreads[0];
            if (!run?.rootNodeId || !run.activeAttemptId || !providerThread)
              return yield* Effect.die(new Error("Missing persisted turn"));
            restore = {
              appThread: projection.thread,
              threadId: projection.thread.id,
              runId: run.id,
              runOrdinal: run.ordinal,
              providerTurnOrdinal: 1,
              attemptId: run.activeAttemptId,
              rootNodeId: run.rootNodeId,
              providerThread,
              message: {
                messageId: MessageId.make("user-a"),
                text: "MUST NOT BE RESUBMITTED",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
              modelSelection,
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: null,
              },
              reattach: true,
            };
          }
        }
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "kilo-cloud-contract" },
            Registry.makeLayer([
              {
                ...adapter,
                openSession: (input) =>
                  adapter.openSession(input).pipe(
                    Effect.map((runtime) => ({
                      ...runtime,
                      startTurn: (input) =>
                        runtime
                          .startTurn(input)
                          .pipe(
                            Effect.catchCause((cause) =>
                              Effect.logError(Cause.pretty(cause)).pipe(
                                Effect.andThen(Effect.failCause(cause)),
                              ),
                            ),
                          ),
                    })),
                  ),
              },
              ...(localAdapter ? [localAdapter] : []),
            ]),
          ),
        ),
      );
      assert.equal(remote.submissions(), 2);
      const entries = yield* journal.read;
      assert.equal(entries.length, 2);
      assert.equal(new Set(entries.map((entry) => entry.binding?.worktreeId)).size, 2);
      assert.isTrue(entries.every((entry) => entry.state === "completed"));
      if (!restore) return yield* Effect.die(new Error("Missing restore input"));
      // Simulate loss of the terminal T3 event after the durable journal commit.
      // Reattaching a fresh runtime must replay terminality without another paid POST.
      const restored = yield* adapter.openSession({
        threadId: restore.threadId,
        providerSessionId: ProviderSessionId.make("cloud-restored"),
        modelSelection,
        runtimePolicy: restore.runtimePolicy,
      });
      const restoredThread = yield* restored.ensureThread({
        threadId: restore.threadId,
        existingProviderThread: restore.providerThread,
        modelSelection,
        runtimePolicy: restore.runtimePolicy,
      });
      const terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
      const replayedMessages: string[] = [];
      const restoredEvents = yield* restored.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "message.updated") replayedMessages.push(event.message.text);
            if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* restored.startTurn({ ...restore, providerThread: restoredThread });
      const event = yield* Deferred.await(terminal);
      assert.isTrue(event.type === "turn.terminal" && event.status === "completed");
      assert.include(replayedMessages, "Remote reply: isolation-a");
      assert.equal(remote.submissions(), 2);
      const restricted = yield* restored
        .startTurn({
          ...restore,
          reattach: false,
          providerThread: restoredThread,
          runtimePolicy: { ...restore.runtimePolicy, runtimeMode: "approval-required" },
        })
        .pipe(Effect.flip);
      assert.include(restricted.message, "cannot enforce restricted permissions");
      assert.equal(remote.submissions(), 2);
      assert.equal((yield* journal.read).length, 2);
      yield* Fiber.interrupt(restoredEvents);
      remote.control.status = "running";
      remote.control.permission = true;
      remote.control.question = true;
      remote.control.incompleteHistory = true;
      const pendingRequest =
        yield* Deferred.make<
          Extract<Adapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
        >();
      const pendingQuestion =
        yield* Deferred.make<
          Extract<Adapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
        >();
      const questionResolved = yield* Deferred.make<void>();
      const resolvedItems: Array<Adapter.ProviderAdapterV2Event> = [];
      const failedWithoutHistory = yield* Deferred.make<void>();
      const failedAndSleeping = yield* Deferred.make<void>();
      yield* restored.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            resolvedItems.push(event);
            if (
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeMetadata?.cloudExecution?.task === "failed" &&
              event.providerThread.nativeMetadata.cloudExecution.sandbox === "sleeping"
            )
              yield* Deferred.succeed(failedAndSleeping, undefined);
            if (
              event.type === "turn_item.updated" &&
              event.turnItem.type === "user_input_request" &&
              event.turnItem.status === "completed"
            )
              yield* Deferred.succeed(questionResolved, undefined);
            if (event.type === "turn.terminal" && event.status === "failed")
              yield* Deferred.succeed(failedWithoutHistory, undefined);
            if (
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.status === "pending"
            )
              yield* Deferred.succeed(
                event.runtimeRequest.kind === "user_input" ? pendingQuestion : pendingRequest,
                event,
              );
          }),
        ),
        Effect.forkScoped,
      );
      yield* restored.startTurn({
        ...restore,
        reattach: false,
        providerThread: restoredThread,
        runId: RunId.make("followup-run"),
        attemptId: RunAttemptId.make("followup-attempt"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        message: {
          ...restore.message,
          messageId: MessageId.make("followup"),
          text: "Follow up in the same workspace",
        },
      });
      const question = yield* Deferred.await(pendingQuestion);
      const unanswered = yield* restored
        .respondToRuntimeRequest({ requestId: question.runtimeRequest.id, answers: {} })
        .pipe(Effect.flip);
      assert.include(unanswered.message, "requires an answer");
      assert.equal(remote.control.questionPosts, 0);
      yield* restored.respondToRuntimeRequest({
        requestId: question.runtimeRequest.id,
        answers: { "0": ["README.md", "fixture.py"] },
      });
      yield* Deferred.await(questionResolved);
      assert.equal(remote.control.questionPosts, 1);
      assert.deepEqual(remote.control.questionAnswers, [["README.md", "fixture.py"]]);
      assert.isTrue(
        resolvedItems.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.questions[0]?.multiSelect === true &&
            event.turnItem.questions[0]?.allowCustomAnswer === false,
        ),
      );
      assert.isTrue(
        resolvedItems.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.status === "completed",
        ),
      );
      const pending = yield* Deferred.await(pendingRequest);
      yield* restored
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.flip);
      remote.control.answerAccepted = true;
      yield* restored.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      assert.equal(remote.control.answerPosts, 2);
      const currentTurn = (yield* journal.read).at(-1)!;
      // A definite rejection permits an explicit retry. It is never an automatic resend.
      const rejectedStop = yield* restored
        .interruptTurn({
          providerThread: restoredThread,
          providerTurnId: currentTurn.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => remote.interruptSeen);
      remote.control.interruptAccepted = true;
      yield* restored.interruptTurn({
        providerThread: restoredThread,
        providerTurnId: currentTurn.providerTurn.id,
      });
      yield* Fiber.join(rejectedStop);
      assert.equal(remote.control.interruptPosts, 2);
      assert.equal(remote.submissions(), 2);
      assert.isTrue(
        resolvedItems.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "approval_request" &&
            event.turnItem.status === "completed",
        ),
      );
      // Reopening with paid admission disabled still restores control and native
      // history; incomplete records from an interrupted turn must stay terminal.
      const controlOnly = yield* CloudAdapter.make({ ...adapterOptions, allowAdmission: false });
      const reopened = yield* controlOnly.openSession({
        threadId: restore.threadId,
        providerSessionId: ProviderSessionId.make("cloud-control-only"),
        modelSelection,
        runtimePolicy: restore.runtimePolicy,
      });
      const reopenedThread = yield* reopened.resumeThread({ providerThread: restoredThread });
      const snapshot = yield* reopened.readThreadSnapshot({ providerThread: reopenedThread });
      assert.isTrue(
        snapshot.messages.some(
          (message) => message.text === "Remote reply: Follow up in the same workspace",
        ),
      );
      assert.isTrue(snapshot.messages.every((message) => !message.streaming));
      const denied = yield* reopened
        .startTurn({ ...restore, providerThread: reopenedThread, reattach: false })
        .pipe(Effect.flip);
      assert.include(denied.message, "Paid cloud execution is disabled");
      assert.equal(remote.submissions(), 2);
      remote.control.status = "failed";
      remote.control.omittedItemCount = 1;
      yield* restored.startTurn({
        ...restore,
        reattach: false,
        providerThread: restoredThread,
        runId: RunId.make("failed-run"),
        attemptId: RunAttemptId.make("failed-attempt"),
        runOrdinal: 3,
        providerTurnOrdinal: 3,
        message: {
          ...restore.message,
          messageId: MessageId.make("failed"),
          text: "Bootstrap failure has no history",
        },
      });
      yield* Deferred.await(failedWithoutHistory);
      yield* Deferred.await(failedAndSleeping);
      assert.isFalse(yield* restored.hasPendingBackgroundWork!);
      assert.equal((yield* journal.read).at(-1)?.state, "failed");
      assert.equal(remote.submissions(), 2);
      // A completed workspace can have no ingested output. Persist the retrieval
      // deadline, restart the adapter, and fail locally without changing remote state.
      remote.control.status = "completed";
      remote.control.missingHistory = true;
      remote.control.omittedItemCount = 0;
      remote.control.incompleteHistory = false;
      const retrievalScope = yield* Scope.fork(yield* Effect.scope);
      const retrieving = yield* adapter
        .openSession({
          threadId: restore.threadId,
          providerSessionId: ProviderSessionId.make("retrieval"),
          modelSelection,
          runtimePolicy: restore.runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, retrievalScope));
      const retrievalThread = yield* retrieving.resumeThread({ providerThread: restoredThread });
      const awaiting = yield* Deferred.make<void>();
      yield* retrieving.events.pipe(
        Stream.runForEach((event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.nativeMetadata?.cloudExecution?.result === "awaiting_result"
            ? Deferred.succeed(awaiting, undefined)
            : Effect.void,
        ),
        Effect.forkIn(retrievalScope),
      );
      const retrievalInput = {
        ...restore,
        reattach: false,
        providerThread: retrievalThread,
        runId: RunId.make("retrieval-run"),
        attemptId: RunAttemptId.make("retrieval-attempt"),
        runOrdinal: 4,
        providerTurnOrdinal: 4,
        message: {
          ...restore.message,
          messageId: MessageId.make("retrieval"),
          text: "Late result",
        },
      };
      yield* retrieving.startTurn(retrievalInput);
      yield* Deferred.await(awaiting);
      const waiting = (yield* journal.read).at(-1)!;
      assert.equal(waiting.state, "awaiting_result");
      assert.equal(waiting.remoteState, "completed");
      assert.isDefined(waiting.resultRecovery?.deadlineMs);
      assert.isFalse(yield* journal.reserve({ ...waiting, operationKey: "duplicate-retrieval" }));
      yield* Scope.close(retrievalScope, Exit.void);
      // Simulate reopening after the durable deadline, without wall-clock sleeps.
      yield* journal.save({
        ...waiting,
        resultRecovery: { ...waiting.resultRecovery!, deadlineMs: 0, nextAttemptMs: 0 },
      });
      const afterRestart = yield* adapter.openSession({
        threadId: restore.threadId,
        providerSessionId: ProviderSessionId.make("retrieval-restart"),
        modelSelection,
        runtimePolicy: restore.runtimePolicy,
      });
      const afterThread = yield* afterRestart.resumeThread({ providerThread: retrievalThread });
      const retrievalEvents: Adapter.ProviderAdapterV2Event[] = [];
      const retrievalFailed = yield* Deferred.make<void>();
      yield* afterRestart.events.pipe(
        Stream.runForEach((event) => {
          retrievalEvents.push(event);
          return event.type === "turn.terminal"
            ? Deferred.succeed(retrievalFailed, undefined)
            : Effect.void;
        }),
        Effect.forkScoped,
      );
      remote.control.question = true;
      const outstanding = yield* afterRestart.readThreadSnapshot({ providerThread: afterThread });
      assert.isTrue(outstanding.runtimeRequests.some((request) => request.status === "pending"));
      assert.equal((yield* journal.read).at(-1)?.state, "awaiting_result");
      // Another client resolves the question; missing output still has a bounded window.
      remote.control.question = false;
      const afterQuestion = (yield* journal.read).at(-1)!;
      yield* journal.save({
        ...afterQuestion,
        resultRecovery: { ...afterQuestion.resultRecovery!, deadlineMs: 0, nextAttemptMs: 0 },
      });
      const unavailable = yield* afterRestart.readThreadSnapshot({ providerThread: afterThread });
      yield* Deferred.await(retrievalFailed);
      assert.equal(unavailable.providerThread.nativeMetadata?.cloudExecution?.task, "completed");
      assert.equal(
        unavailable.providerThread.nativeMetadata?.cloudExecution?.result,
        "unavailable",
      );
      assert.equal((yield* journal.read).at(-1)?.state, "failed");
      const failure = retrievalEvents.find((event) => event.type === "turn.terminal");
      assert.isTrue(
        failure?.type === "turn.terminal" &&
          failure.status === "failed" &&
          failure.failure?.code === "kilo_cloud_result_unavailable" &&
          failure.failure.retryable === false &&
          failure.failure.message.includes("result could not be retrieved"),
      );
      remote.control.missingHistory = false;
      const late = yield* afterRestart.readThreadSnapshot({ providerThread: afterThread });
      const repeatedLate = yield* afterRestart.readThreadSnapshot({ providerThread: afterThread });
      assert.equal(
        late.messages.filter((message) => message.text === "Remote reply: Late result").length,
        1,
      );
      assert.deepEqual(
        repeatedLate.messages.map((message) => message.id),
        late.messages.map((message) => message.id),
      );
      assert.equal((yield* journal.read).at(-1)?.resultStatus, "available");
      assert.equal(retrievalEvents.filter((event) => event.type === "turn.terminal").length, 1);
      assert.equal(remote.submissions(), 2);
      // Stop during retrieval is local cancellation, never a remote interrupt.
      remote.control.missingHistory = true;
      const cancelling = yield* adapter.openSession({
        threadId: restore.threadId,
        providerSessionId: ProviderSessionId.make("retrieval-cancel"),
        modelSelection,
        runtimePolicy: restore.runtimePolicy,
      });
      const cancelThread = yield* cancelling.resumeThread({ providerThread: afterThread });
      const cancelAwaiting = yield* Deferred.make<void>();
      yield* cancelling.events.pipe(
        Stream.runForEach((event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.nativeMetadata?.cloudExecution?.result === "awaiting_result"
            ? Deferred.succeed(cancelAwaiting, undefined)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* cancelling.startTurn({
        ...retrievalInput,
        providerThread: cancelThread,
        runId: RunId.make("cancel-run"),
        attemptId: RunAttemptId.make("cancel-attempt"),
        runOrdinal: 5,
        providerTurnOrdinal: 5,
        message: {
          ...restore.message,
          messageId: MessageId.make("cancel-retrieval"),
          text: "Cancel retrieval",
        },
      });
      yield* Deferred.await(cancelAwaiting);
      const cancellingIntent = (yield* journal.read).at(-1)!;
      const interruptPosts = remote.control.interruptPosts;
      yield* cancelling.interruptTurn({
        providerThread: cancelThread,
        providerTurnId: cancellingIntent.providerTurn.id,
      });
      assert.equal(remote.control.interruptPosts, interruptPosts);
      const cancelled = (yield* journal.read).at(-1)!;
      assert.equal(cancelled.state, "interrupted");
      assert.equal(cancelled.remoteState, "completed");
      assert.equal(cancelled.resultStatus, "cancelled");
      remote.control.missingHistory = false;
      for (const [index, mode] of [
        "empty",
        "tool-only",
        "unfinished",
        "repeated",
        "paged",
      ].entries()) {
        remote.control.historyMode = mode;
        remote.control.historyReads = 0;
        const testScope = yield* Scope.fork(yield* Effect.scope);
        const runtime = yield* adapter
          .openSession({
            threadId: restore.threadId,
            providerSessionId: ProviderSessionId.make(`result-${mode}`),
            modelSelection,
            runtimePolicy: restore.runtimePolicy,
          })
          .pipe(Effect.provideService(Scope.Scope, testScope));
        const selected = yield* runtime.resumeThread({ providerThread: cancelThread });
        const done = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
        const waitingResult = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "turn.terminal") yield* Deferred.succeed(done, event);
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.nativeMetadata?.cloudExecution?.result === "awaiting_result"
              )
                yield* Deferred.succeed(waitingResult, undefined);
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.nativeMetadata?.cloudExecution?.task === "admission_unknown"
              )
                assert.isUndefined(event.providerThread.nativeMetadata.cloudExecution.result);
            }),
          ),
          Effect.forkIn(testScope),
        );
        yield* runtime.startTurn({
          ...retrievalInput,
          providerThread: selected,
          runId: RunId.make(`result-${mode}`),
          attemptId: RunAttemptId.make(`result-attempt-${mode}`),
          runOrdinal: 6 + index,
          providerTurnOrdinal: 6 + index,
          message: { ...restore.message, messageId: MessageId.make(`result-${mode}`), text: mode },
        });
        if (mode === "unfinished" || mode === "repeated") {
          yield* Deferred.await(waitingResult);
          const unfinished = (yield* journal.read).at(-1)!;
          assert.equal(unfinished.state, "awaiting_result");
          yield* runtime.interruptTurn({
            providerThread: selected,
            providerTurnId: unfinished.providerTurn.id,
          });
          const stopped = (yield* journal.read).at(-1)!;
          assert.equal(stopped.state, "interrupted");
          assert.equal(stopped.resultStatus, "cancelled");
          assert.equal(stopped.remoteState, "completed");
        } else {
          if (mode === "paged") {
            yield* Deferred.await(waitingResult);
            assert.equal(remote.control.historyReads, 4);
            assert.equal((yield* journal.read).at(-1)?.resultRecovery?.cursor, "4");
          }
          const terminal = yield* Deferred.await(done);
          assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
          assert.equal((yield* journal.read).at(-1)?.resultStatus, "available");
        }
        yield* Scope.close(testScope, Exit.void);
      }
      remote.control.historyMode = "older";
      const older = yield* cancelling.readThreadSnapshot({ providerThread: cancelThread });
      assert.isTrue(older.messages.some((message) => message.id === "user-a"));
      assert.isTrue(older.messages.some((message) => message.id === "result-paged"));
      remote.control.historyMode = "normal";
      const first = (yield* journal.read)[0]!;
      yield* journal.save({ ...first, interruptRequested: true });
      assert.equal((yield* replacementForStale()).operation, "write");
      function replacementForStale() {
        return journal.save({ ...first, interruptRequested: false }).pipe(Effect.flip);
      }
      assert.equal(
        (yield* journal.save({ ...first, accountId: "another-account" }).pipe(Effect.flip))
          .operation,
        "write",
      );
      assert.equal(
        (yield* journal.save({ ...first, state: "active" }).pipe(Effect.flip)).operation,
        "write",
      );
      const replacement = yield* Journal.make(directory);
      const concurrent = {
        ...first,
        state: "admission_unknown" as const,
        providerThread: {
          ...first.providerThread,
          id: ProviderThreadId.make("same-racing-thread"),
        },
      };
      const reservations = yield* Effect.all(
        [
          journal.reserve({ ...concurrent, operationKey: "race-a" }),
          replacement.reserve({ ...concurrent, operationKey: "race-b" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(reservations.filter(Boolean).length, 1);
      assert.equal(
        (yield* replacement.read).filter(
          (entry) => entry.providerThread.id === concurrent.providerThread.id,
        ).length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  60_000,
);

const admissionHarness = Effect.fn("admissionHarness")(function* (
  remote: Effect.Success<typeof fixture>,
  directory: string,
) {
  const instanceId = ProviderInstanceId.make("cloud-admission");
  const threadId = ThreadId.make("admission-thread");
  const now = yield* DateTime.now;
  const modelSelection = { instanceId, model: "fixture/model" };
  const runtimePolicy = {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: null,
  };
  const account = yield* Account.make(directory, remote.origin);
  const journal = yield* Journal.make(`${directory}/journal`);
  const client = Cloud.make({
    accountId: "fixture-account",
    token: Redacted.make("fixture"),
    origin: remote.origin,
    credentials: account.load,
  });
  const adapter = yield* CloudAdapter.make({
    instanceId,
    continuationKey: "admission-account",
    accountId: "fixture-account",
    repository: "fixture/repo",
    branch: "main",
    client,
    journal,
  });
  const initial: import("@t3tools/contracts").OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("admission-provider-thread"),
    driver: ProviderDriverKind.make("kilo-cloud"),
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const open = Effect.gen(function* () {
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("admission-session"),
      modelSelection,
      runtimePolicy,
    });
    const thread = yield* runtime.resumeThread({ providerThread: initial });
    return { runtime, thread };
  });
  const turn = (thread: typeof initial, ordinal = 1): Adapter.ProviderAdapterV2TurnInput => ({
    appThread: {
      id: threadId,
      projectId: ProjectId.make("admission-project"),
      title: "Admission fixture",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: thread.id,
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
    runId: RunId.make(`admission-run-${ordinal}`),
    attemptId: RunAttemptId.make(`admission-attempt-${ordinal}`),
    rootNodeId: NodeId.make(`admission-node-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    providerThread: thread,
    message: {
      messageId: MessageId.make(`admission-message-${ordinal}`),
      text: "Read synthetic README",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  });
  return { open, turn, journal, client };
});

it.live.each([
  "404",
  "503",
  "malformed",
  "profile-503",
  "profile-malformed",
  "personal-account",
  "wrong-account",
  "credential",
  "last-credential",
] as const)(
  "ends proven unsent %s preflight and permits an explicit next turn after restart",
  (mode) =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      const auth = `${directory}/data/kilo/auth.json`;
      const validAuth = '{"kilo":{"type":"api","key":"synthetic-test-token"}}';
      yield* fs.writeFileString(auth, mode === "credential" ? "{}" : validAuth);
      if (mode === "404" || mode === "503") remote.control.preflightStatus = Number(mode);
      if (mode === "malformed") remote.control.malformedPreflight = true;
      if (mode === "profile-503") remote.control.profileStatus = 503;
      if (mode === "profile-malformed") remote.control.malformedProfile = true;
      if (mode === "personal-account") remote.control.personalAccount = false;
      if (mode === "wrong-account") remote.control.profileAccount = "another-account";
      if (mode === "last-credential")
        remote.control.afterBindings = () => NodeFS.writeFileSync(auth, "{}");
      const harness = yield* admissionHarness(remote, directory);
      const scope = yield* Scope.fork(yield* Effect.scope);
      const first = yield* harness.open.pipe(Effect.provideService(Scope.Scope, scope));
      yield* first.runtime.startTurn(harness.turn(first.thread));
      const intent = (yield* harness.journal.read)[0]!;
      assert.equal(remote.submissions(), 0);
      assert.equal(intent.state, "failed");
      assert.equal(intent.submissionPhase, "preflight");
      yield* first.runtime.interruptTurn({
        providerThread: first.thread,
        providerTurnId: intent.providerTurn.id,
      });
      assert.equal(remote.control.interruptPosts, 0);
      yield* Scope.close(scope, Exit.void);
      remote.control.preflightStatus = 200;
      remote.control.malformedPreflight = false;
      remote.control.profileStatus = 200;
      remote.control.malformedProfile = false;
      remote.control.personalAccount = true;
      remote.control.profileAccount = "fixture-account";
      remote.control.afterBindings = undefined;
      yield* fs.writeFileString(auth, validAuth);
      // New account, client, journal and runtime; the original durable record remains.
      const restarted = yield* admissionHarness(remote, directory);
      const next = yield* restarted.open;
      remote.control.status = "failed";
      const done = yield* Deferred.make<void>();
      yield* next.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(done, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* next.runtime.startTurn(restarted.turn(next.thread, 2));
      yield* Deferred.await(done);
      assert.equal(remote.submissions(), 1);
      assert.equal((yield* restarted.journal.read)[1]?.submissionPhase, "post_attempted");
      assert.equal((yield* restarted.journal.read)[1]?.state, "failed");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live.each([false, true])(
  "keeps a lost POST uncertain across restart and Stop, legacy=%s",
  (legacy) =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      remote.control.dropNextPrepare = true;
      remote.control.hideAdmissions = true;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/data/kilo/auth.json`,
        '{"kilo":{"type":"api","key":"synthetic"}}',
      );
      const harness = yield* admissionHarness(remote, directory);
      const scope = yield* Scope.fork(yield* Effect.scope);
      const first = yield* harness.open.pipe(Effect.provideService(Scope.Scope, scope));
      yield* first.runtime.startTurn(harness.turn(first.thread));
      yield* Scope.close(scope, Exit.void);
      let uncertain = (yield* harness.journal.read)[0]!;
      assert.equal(uncertain.state, "admission_unknown");
      assert.equal(uncertain.submissionPhase, "post_attempted");
      assert.equal(remote.submissions(), 1);
      if (legacy) {
        const old = { ...uncertain };
        delete old.submissionPhase;
        uncertain = yield* harness.journal.save(old);
      }
      const restarted = yield* admissionHarness(remote, directory);
      const next = yield* restarted.open;
      yield* next.runtime.startTurn({ ...restarted.turn(next.thread), reattach: true });
      const baseClock = yield* Clock.Clock;
      const laterClock = clockAt(baseClock, (yield* Clock.currentTimeMillis) + 86_400_000);
      yield* next.runtime
        .readThreadSnapshot({ providerThread: next.thread })
        .pipe(Effect.provideService(Clock.Clock, laterClock));
      const stop = yield* next.runtime
        .interruptTurn({ providerThread: next.thread, providerTurnId: uncertain.providerTurn.id })
        .pipe(Effect.flip);
      assert.include(stop.message, "no confirmed session ID");
      const retry = yield* next.runtime.startTurn(restarted.turn(next.thread, 2)).pipe(Effect.flip);
      assert.include(retry.message, "admission is unknown");
      assert.equal((yield* restarted.journal.read)[0]?.state, "admission_unknown");
      assert.equal(remote.submissions(), 1);
      assert.equal(remote.control.interruptPosts, 0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "a recovered preflight reservation prevents the original waiting adapter from dispatching",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/data/kilo/auth.json`,
        '{"kilo":{"type":"api","key":"synthetic"}}',
      );
      const arrived = yield* Deferred.make<void>();
      remote.control.parkPreflight = true;
      remote.control.preflightSeen = () => Deferred.doneUnsafe(arrived, Effect.void);
      const firstHarness = yield* admissionHarness(remote, directory);
      const first = yield* firstHarness.open;
      const pending = yield* first.runtime
        .startTurn(firstHarness.turn(first.thread))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(arrived);
      assert.equal((yield* firstHarness.journal.read)[0]?.submissionPhase, "preflight");
      const recovery = yield* admissionHarness(remote, directory);
      const reopened = yield* recovery.open;
      const recovered = (yield* recovery.journal.read)[0]!;
      assert.equal(recovered.state, "failed");
      yield* reopened.runtime.interruptTurn({
        providerThread: reopened.thread,
        providerTurnId: recovered.providerTurn.id,
      });
      remote.control.parkPreflight = false;
      remote.control.parkedPreflight!.writeHead(200, { "content-type": "application/json" });
      remote.control.parkedPreflight!.end('{"result":{"data":[]}}');
      const originalExit = yield* Fiber.await(pending);
      assert.isTrue(Exit.isFailure(originalExit)); // stale CAS cannot revive the reservation
      assert.equal(remote.submissions(), 0);
      assert.equal((yield* recovery.journal.read)[0]?.state, "failed");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "persists result backoff and reattaches without resetting attempts or the deadline",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      remote.control.missingHistory = true;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/data/kilo/auth.json`,
        '{"kilo":{"type":"api","key":"synthetic"}}',
      );
      const harness = yield* admissionHarness(remote, directory);
      const firstScope = yield* Scope.fork(yield* Effect.scope);
      const first = yield* harness.open.pipe(Effect.provideService(Scope.Scope, firstScope));
      const waiting = yield* Deferred.make<void>();
      yield* first.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.nativeMetadata?.cloudExecution?.result === "awaiting_result"
            ? Deferred.succeed(waiting, undefined)
            : Effect.void,
        ),
        Effect.forkIn(firstScope),
      );
      yield* first.runtime.startTurn(harness.turn(first.thread));
      yield* Deferred.await(waiting);
      yield* Scope.close(firstScope, Exit.void);
      const saved = (yield* harness.journal.read)[0]!;
      assert.equal(saved.state, "awaiting_result");
      assert.equal(saved.resultRecovery?.attempts, 1);
      const deadline = saved.resultRecovery!.deadlineMs;
      const due = saved.resultRecovery!.nextAttemptMs;
      const baseClock = yield* Clock.Clock;
      const restarted = yield* admissionHarness(remote, directory);
      const next = yield* restarted.open;
      const reads = remote.control.historyReads;
      yield* next.runtime
        .readThreadSnapshot({ providerThread: next.thread })
        .pipe(Effect.provideService(Clock.Clock, clockAt(baseClock, due - 1)));
      assert.equal(remote.control.historyReads, reads);
      assert.deepEqual((yield* restarted.journal.read)[0]?.resultRecovery, saved.resultRecovery);
      yield* next.runtime
        .readThreadSnapshot({ providerThread: next.thread })
        .pipe(Effect.provideService(Clock.Clock, clockAt(baseClock, due)));
      const second = (yield* restarted.journal.read)[0]!.resultRecovery!;
      assert.equal(second.attempts, 2);
      assert.equal(second.nextAttemptMs, due + 4_000);
      assert.equal(second.deadlineMs, deadline);
      assert.equal(remote.control.historyReads, reads + 1);
      let recovery = second;
      for (const delay of [8_000, 16_000, 30_000, 30_000]) {
        const at = recovery.nextAttemptMs;
        yield* next.runtime
          .readThreadSnapshot({ providerThread: next.thread })
          .pipe(Effect.provideService(Clock.Clock, clockAt(baseClock, at)));
        const following = (yield* restarted.journal.read)[0]!.resultRecovery!;
        assert.equal(following.attempts, recovery.attempts + 1);
        assert.equal(following.nextAttemptMs, at + delay);
        assert.equal(following.deadlineMs, deadline);
        recovery = following;
      }

      // Reattach the original turn at expiry. Its terminal event must be replayable,
      // with remote completion retained and no replacement paid submission.
      const terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
      yield* next.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(terminal, event) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* next.runtime
        .startTurn({ ...restarted.turn(next.thread), reattach: true })
        .pipe(Effect.provideService(Clock.Clock, clockAt(baseClock, deadline + 1)));
      const failed = yield* Deferred.await(terminal);
      assert.isTrue(failed.type === "turn.terminal" && failed.status === "failed");
      const ended = (yield* restarted.journal.read)[0]!;
      assert.equal(ended.state, "failed");
      assert.equal(ended.remoteState, "completed");
      assert.equal(ended.resultStatus, "unavailable");
      assert.equal(remote.submissions(), 1);
      const replay = yield* restarted.open;
      const replayed = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
      yield* replay.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(replayed, event) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* replay.runtime.startTurn({ ...restarted.turn(replay.thread), reattach: true });
      const event = yield* Deferred.await(replayed);
      assert.isTrue(event.type === "turn.terminal" && event.status === "failed");
      if (event.type === "turn.terminal" && event.status === "failed")
        assert.include(event.failure?.message ?? "", "unavailable before the recovery deadline");
      assert.equal(remote.submissions(), 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live.each(["404", "503", "malformed", "credential"] as const)(
  "does not dispatch a follow-up after %s preflight failure and keeps the remote binding",
  (mode) =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      remote.control.status = "failed";
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      const auth = `${directory}/data/kilo/auth.json`;
      const validAuth = '{"kilo":{"type":"api","key":"synthetic"}}';
      yield* fs.writeFileString(auth, validAuth);
      const harness = yield* admissionHarness(remote, directory);
      const firstScope = yield* Scope.fork(yield* Effect.scope);
      const first = yield* harness.open.pipe(Effect.provideService(Scope.Scope, firstScope));
      const done = yield* Deferred.make<void>();
      yield* first.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(done, undefined) : Effect.void,
        ),
        Effect.forkIn(firstScope),
      );
      yield* first.runtime.startTurn(harness.turn(first.thread));
      yield* Deferred.await(done);
      yield* Scope.close(firstScope, Exit.void);
      const binding = (yield* harness.journal.read)[0]!.binding;
      assert.isNotNull(binding);
      if (mode === "404" || mode === "503") remote.control.sessionStatus = Number(mode);
      if (mode === "malformed") remote.control.malformedSession = true;
      if (mode === "credential") yield* fs.writeFileString(auth, "{}");
      const secondScope = yield* Scope.fork(yield* Effect.scope);
      const second = yield* harness.open.pipe(Effect.provideService(Scope.Scope, secondScope));
      yield* second.runtime.startTurn(harness.turn(second.thread, 2));
      const failed = (yield* harness.journal.read)[1]!;
      assert.equal(failed.state, "failed");
      assert.equal(failed.submissionPhase, "preflight");
      assert.deepEqual(failed.binding, binding);
      assert.equal(remote.control.sendPosts, 0);
      yield* second.runtime.interruptTurn({
        providerThread: second.thread,
        providerTurnId: failed.providerTurn.id,
      });
      assert.equal(remote.control.interruptPosts, 0);
      yield* Scope.close(secondScope, Exit.void);
      remote.control.sessionStatus = 200;
      remote.control.malformedSession = false;
      yield* fs.writeFileString(auth, validAuth);
      const restarted = yield* admissionHarness(remote, directory);
      const third = yield* restarted.open;
      const completed = yield* Deferred.make<void>();
      yield* third.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(completed, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* third.runtime.startTurn(restarted.turn(third.thread, 3));
      yield* Deferred.await(completed);
      assert.equal(remote.submissions(), 1);
      assert.equal(remote.control.sendPosts, 1);
      assert.equal((yield* restarted.journal.read)[2]?.submissionPhase, "post_attempted");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "pauses incomplete admission scans durably and restarts observation after a manual read retry",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      remote.control.dropNextPrepare = true;
      remote.control.listStatus = 503;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/data/kilo/auth.json`,
        '{"kilo":{"type":"api","key":"synthetic"}}',
      );
      const harness = yield* admissionHarness(remote, directory);
      const scope = yield* Scope.fork(yield* Effect.scope);
      const first = yield* harness.open.pipe(Effect.provideService(Scope.Scope, scope));
      yield* first.runtime.startTurn(harness.turn(first.thread));
      yield* Scope.close(scope, Exit.void);
      const restarted = yield* admissionHarness(remote, directory);
      const next = yield* restarted.open;
      const baseClock = yield* Clock.Clock;
      const now = yield* Clock.currentTimeMillis;
      for (let i = 0; i < 3; i++) {
        if ((yield* restarted.journal.read)[0]?.admissionRecoveryPaused) break;
        yield* next.runtime
          .readThreadSnapshot({ providerThread: next.thread })
          .pipe(Effect.provideService(Clock.Clock, clockAt(baseClock, now + i * 61_000)));
      }
      const paused = (yield* restarted.journal.read)[0]!;
      assert.equal(paused.state, "admission_unknown");
      assert.isTrue(paused.admissionRecoveryPaused);
      assert.equal(paused.admissionRecoveryFailures, 3);
      assert.isFalse(yield* next.runtime.hasPendingBackgroundWork!);
      const again = yield* admissionHarness(remote, directory);
      const recovered = yield* again.open;
      yield* recovered.runtime.startTurn({ ...again.turn(recovered.thread), reattach: true });
      assert.isTrue((yield* again.journal.read)[0]?.admissionRecoveryPaused);
      assert.isFalse(yield* recovered.runtime.hasPendingBackgroundWork!);
      remote.control.listStatus = 200;
      remote.control.resultReads = 0;
      remote.control.status = "running"; // Inference can complete while sandbox and billing remain active.
      remote.control.completeAfterResultReads = 2;
      const done = yield* Deferred.make<void>();
      yield* recovered.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(done, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* recovered.runtime.readThreadSnapshot({ providerThread: recovered.thread });
      yield* Deferred.await(done); // watcher must finish without a second snapshot request
      const complete = (yield* again.journal.read)[0]!;
      assert.equal(complete.state, "completed");
      assert.isFalse(complete.admissionRecoveryPaused);
      assert.isAtLeast(remote.control.resultReads, 2);
      assert.isTrue(yield* recovered.runtime.hasPendingBackgroundWork!);
      remote.control.status = "completed";
      const sleeping = yield* recovered.runtime.readThreadSnapshot({
        providerThread: recovered.thread,
      });
      assert.equal(sleeping.providerThread.nativeMetadata?.cloudExecution?.sandbox, "sleeping");
      assert.equal(sleeping.providerThread.nativeMetadata?.cloudExecution?.billing, "idle");
      assert.isFalse(yield* recovered.runtime.hasPendingBackgroundWork!);
      assert.equal(remote.submissions(), 1);
      assert.equal(remote.control.sendPosts, 0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.effect(
  "bounds stalled admission-list reads across durable failures without releasing a paid intent",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      remote.control.dropNextPrepare = true;
      remote.control.hideAdmissions = true;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/data/kilo/auth.json`,
        '{"kilo":{"type":"api","key":"synthetic"}}',
      );
      const harness = yield* admissionHarness(remote, directory);
      const firstScope = yield* Scope.fork(yield* Effect.scope);
      const first = yield* harness.open.pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* first.runtime.startTurn(harness.turn(first.thread));
      yield* Scope.close(firstScope, Exit.void);
      const restarted = yield* admissionHarness(remote, directory);
      const next = yield* restarted.open;
      remote.control.parkList = true;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const requestSeen = yield* Deferred.make<void>();
        const requestClosed = yield* Deferred.make<void>();
        remote.control.listSeen = () => Deferred.doneUnsafe(requestSeen, Effect.void);
        remote.control.listClosed = () => Deferred.doneUnsafe(requestClosed, Effect.void);
        const reading = yield* next.runtime
          .readThreadSnapshot({ providerThread: next.thread })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(requestSeen);
        yield* TestClock.adjust("8 seconds");
        yield* Fiber.join(reading);
        yield* Deferred.await(requestClosed);
        const saved = (yield* restarted.journal.read)[0]!;
        assert.equal(saved.admissionRecoveryFailures, attempt);
        assert.equal(saved.state, "admission_unknown");
        assert.equal(saved.admissionRecoveryPaused, attempt === 3);
      }
      assert.isFalse(yield* next.runtime.hasPendingBackgroundWork!);
      assert.equal(remote.submissions(), 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

const uncertainAdmission = Effect.gen(function* () {
  const remote = yield* fixture;
  remote.control.dropNextPrepare = true;
  remote.control.hideAdmissions = true;
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
  yield* fs.writeFileString(
    `${directory}/data/kilo/auth.json`,
    '{"kilo":{"type":"api","key":"synthetic"}}',
  );
  const harness = yield* admissionHarness(remote, directory);
  const firstScope = yield* Scope.fork(yield* Effect.scope);
  const first = yield* harness.open.pipe(Effect.provideService(Scope.Scope, firstScope));
  yield* first.runtime.startTurn(harness.turn(first.thread));
  yield* Scope.close(firstScope, Exit.void);
  return { remote, directory };
});

it.live(
  "bounds recovery when real SQLite UPDATEs fail and retains the paid reservation",
  () =>
    Effect.gen(function* () {
      const { remote, directory } = yield* uncertainAdmission;
      remote.control.listStatus = 503;
      const harness = yield* admissionHarness(remote, directory);
      const opened = yield* harness.open;
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(`${directory}/journal/intents.sqlite`)),
        (db) => Effect.sync(() => db.close()),
      );
      db.exec(
        "CREATE TRIGGER fail_recovery_save BEFORE UPDATE ON intents BEGIN SELECT RAISE(FAIL, 'fixture write failure'); END",
      );
      const baseClock = yield* Clock.Clock;
      const now = yield* Clock.currentTimeMillis;
      for (let attempt = 0; attempt < 3; attempt++) {
        yield* opened.runtime
          .readThreadSnapshot({ providerThread: opened.thread })
          .pipe(
            Effect.provideService(Clock.Clock, clockAt(baseClock, now + attempt * 61_000)),
            Effect.ignore,
          );
      }
      assert.isFalse(yield* opened.runtime.hasPendingBackgroundWork!);
      const saved = (yield* harness.journal.read)[0]!;
      assert.equal(saved.state, "admission_unknown");
      assert.equal(saved.submissionPhase, "post_attempted");
      yield* opened.runtime
        .interruptTurn({ providerThread: opened.thread, providerTurnId: saved.providerTurn.id })
        .pipe(Effect.flip);
      yield* opened.runtime.startTurn(harness.turn(opened.thread, 2)).pipe(Effect.flip);
      assert.equal(remote.control.preparePosts, 1);
      // Persisted uncertainty survives a new adapter even though the failed disk
      // could not persist the local pause. No paid retry is permitted.
      const restarted = yield* admissionHarness(remote, directory);
      const next = yield* restarted.open;
      yield* next.runtime.startTurn(restarted.turn(next.thread, 2)).pipe(Effect.flip);
      const paused = yield* opened.runtime
        .readThreadSnapshot({ providerThread: opened.thread })
        .pipe(Effect.flip);
      assert.include(paused.message, "Cloud recovery remains paused");
      assert.equal(remote.control.preparePosts, 1);
      db.exec("DROP TRIGGER fail_recovery_save");
      remote.control.listStatus = 200;
      remote.control.hideAdmissions = false;
      const recovered = yield* opened.runtime.readThreadSnapshot({ providerThread: opened.thread });
      assert.equal(recovered.providerThread.nativeMetadata?.cloudExecution?.task, "completed");
      assert.equal((yield* harness.journal.read)[0]?.state, "completed");
      assert.equal(remote.control.preparePosts, 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "adopts another adapter's durable recovery before probing with a stale revision",
  () =>
    Effect.gen(function* () {
      const { remote, directory } = yield* uncertainAdmission;
      remote.control.hideAdmissions = false;
      remote.control.status = "running";
      const a = yield* admissionHarness(remote, directory);
      const b = yield* admissionHarness(remote, directory);
      const first = yield* a.open;
      const winner = yield* b.open;
      yield* winner.runtime.readThreadSnapshot({ providerThread: winner.thread });
      const reads = remote.control.listReads;
      const adopted = yield* first.runtime.readThreadSnapshot({ providerThread: first.thread });
      assert.equal(remote.control.listReads, reads);
      assert.equal(adopted.providerThread.nativeMetadata?.cloudExecution?.task, "running");
      assert.equal((yield* a.journal.read)[0]?.state, "active");
      remote.control.interruptAccepted = true;
      const saved = (yield* a.journal.read)[0]!;
      yield* first.runtime.interruptTurn({
        providerThread: first.thread,
        providerTurnId: saved.providerTurn.id,
      });
      yield* winner.runtime.readThreadSnapshot({ providerThread: winner.thread });
      assert.equal((yield* b.journal.read)[0]?.state, "interrupted");
      assert.equal(remote.control.interruptPosts, 1);
      assert.equal(remote.control.preparePosts, 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "resets admission failures on progress and resets the retry cadence after manual resume",
  () =>
    Effect.gen(function* () {
      const { remote, directory } = yield* uncertainAdmission;
      const harness = yield* admissionHarness(remote, directory);
      const opened = yield* harness.open;
      const baseClock = yield* Clock.Clock;
      const now = yield* Clock.currentTimeMillis;
      const readAt = (ms: number) =>
        opened.runtime
          .readThreadSnapshot({ providerThread: opened.thread })
          .pipe(Effect.provideService(Clock.Clock, clockAt(baseClock, now + ms)));
      for (const [index, status] of [503, 200, 503].entries()) {
        remote.control.listStatus = status;
        yield* readAt(index * 61_000);
        assert.equal(
          (yield* harness.journal.read)[0]?.admissionRecoveryFailures,
          status === 200 ? 0 : 1,
        );
        assert.isFalse((yield* harness.journal.read)[0]?.admissionRecoveryPaused);
      }
      yield* readAt(183_000);
      yield* readAt(244_000);
      assert.isTrue((yield* harness.journal.read)[0]?.admissionRecoveryPaused);
      remote.control.listStatus = 200;
      yield* readAt(305_000); // Explicit resume; a successful empty scan is still uncertain.
      const reads = remote.control.listReads;
      yield* readAt(306_999);
      assert.equal(remote.control.listReads, reads);
      remote.control.hideAdmissions = false;
      yield* readAt(307_000);
      assert.isAbove(remote.control.listReads, reads);
      assert.equal((yield* harness.journal.read)[0]?.state, "completed");
      assert.equal(remote.control.preparePosts, 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "reports a sent but rejected POST separately from an unsent request across restart",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      remote.control.prepareStatus = 400;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/data/kilo/auth.json`,
        '{"kilo":{"type":"api","key":"synthetic"}}',
      );
      const harness = yield* admissionHarness(remote, directory);
      const opened = yield* harness.open;
      const terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
      yield* opened.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(terminal, event) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* opened.runtime.startTurn(harness.turn(opened.thread));
      const event = yield* Deferred.await(terminal);
      assert.equal(event.type, "turn.terminal");
      if (event.type === "turn.terminal") {
        assert.equal(event.failure?.code, "kilo_cloud_submission_rejected");
        assert.notInclude(event.failure?.message ?? "", "No paid request was sent");
      }
      const saved = (yield* harness.journal.read)[0]!;
      assert.equal(saved.submissionPhase, "post_attempted");
      assert.isTrue(saved.submissionRejected);
      assert.equal(remote.control.preparePosts, 1);
      const restored = yield* (yield* admissionHarness(remote, directory)).open;
      assert.equal(restored.thread.nativeMetadata?.cloudExecution?.task, "not_started");
      remote.control.prepareStatus = 200;
      yield* restored.runtime.startTurn(harness.turn(restored.thread, 2));
      assert.equal(remote.control.preparePosts, 2);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "finishes a durably rejected submission after a crash before terminal save",
  () =>
    Effect.gen(function* () {
      const { remote, directory } = yield* uncertainAdmission;
      const harness = yield* admissionHarness(remote, directory);
      const saved = (yield* harness.journal.read)[0]!;
      // Reproduce the durable boundary after a definite rejection, before finish.
      yield* harness.journal.save({ ...saved, submissionRejected: true });
      const reads = remote.control.listReads;
      const resumed = yield* harness.open;
      assert.equal((yield* harness.journal.read)[0]?.state, "failed");
      assert.equal((yield* harness.journal.read)[0]?.submissionPhase, "post_attempted");
      assert.equal(resumed.thread.nativeMetadata?.cloudExecution?.task, "not_started");
      assert.equal(remote.control.listReads, reads);
      assert.equal(remote.control.preparePosts, 1);
      remote.control.hideAdmissions = false;
      yield* resumed.runtime.startTurn(harness.turn(resumed.thread, 2));
      assert.equal(remote.control.preparePosts, 2);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "adopts a terminal preflight Stop from another adapter without rewriting its outcome",
  () =>
    Effect.gen(function* () {
      const { remote, directory } = yield* uncertainAdmission;
      const harness = yield* admissionHarness(remote, directory);
      const opened = yield* harness.open;
      const saved = (yield* harness.journal.read)[0]!;
      // A concurrent preflight owner may finish Stop before this reader refreshes.
      // SQL restores that durable boundary without loosening production phase guards.
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(`${directory}/journal/intents.sqlite`)),
        (db) => Effect.sync(() => db.close()),
      );
      db.prepare("UPDATE intents SET state = ?, body = ? WHERE operation_key = ?").run(
        "interrupted",
        yield* encodeIntent({
          ...saved,
          revision: saved.revision + 1,
          state: "interrupted",
          submissionPhase: "preflight",
        }),
        saved.operationKey,
      );
      const reads = remote.control.listReads;
      yield* opened.runtime.readThreadSnapshot({ providerThread: opened.thread });
      assert.equal((yield* harness.journal.read)[0]?.state, "interrupted");
      assert.equal(remote.control.listReads, reads);
      assert.isFalse(yield* opened.runtime.hasPendingBackgroundWork!);
      assert.equal(remote.control.preparePosts, 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live.each(["pause", "terminal"] as const)(
  "preserves a concurrent %s after a failed admission probe",
  (outcome) =>
    Effect.gen(function* () {
      const { remote, directory } = yield* uncertainAdmission;
      const harness = yield* admissionHarness(remote, directory);
      const initial = (yield* harness.journal.read)[0]!;
      yield* harness.journal.save({
        ...initial,
        admissionRecoveryFailures: outcome === "terminal" ? 2 : 0,
      });
      const opened = yield* harness.open;
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(`${directory}/journal/intents.sqlite`)),
        (db) => Effect.sync(() => db.close()),
      );
      if (outcome === "terminal")
        db.exec(
          "CREATE TRIGGER reject_pause BEFORE UPDATE ON intents WHEN json_extract(NEW.body, '$.admissionRecoveryPaused') = 1 BEGIN SELECT RAISE(FAIL, 'fixture pause write failure'); END",
        );
      remote.control.parkList = true;
      const seen = yield* Deferred.make<void>();
      remote.control.listSeen = () => Deferred.doneUnsafe(seen, Effect.void);
      const reading = yield* opened.runtime
        .readThreadSnapshot({ providerThread: opened.thread })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(seen);
      const other = yield* Journal.make(`${directory}/journal`);
      const latest = (yield* other.read)[0]!;
      yield* other.save(
        outcome === "pause"
          ? { ...latest, admissionRecoveryFailures: 9, admissionRecoveryPaused: true }
          : {
              ...latest,
              state: "interrupted",
              providerTurn: {
                ...latest.providerTurn,
                status: "interrupted",
                completedAt: yield* DateTime.now,
              },
            },
      );
      remote.control.parkList = false;
      remote.control.parkedList!.writeHead(503);
      remote.control.parkedList!.end();
      yield* Fiber.join(reading);
      const final = (yield* harness.journal.read)[0]!;
      if (outcome === "pause") {
        assert.isTrue(final.admissionRecoveryPaused);
        assert.isAtLeast(final.admissionRecoveryFailures!, 9);
      } else {
        assert.equal(final.state, "interrupted");
        // Finishing the adopted turn must retire a failed local pause, too.
        yield* opened.runtime.readThreadSnapshot({ providerThread: opened.thread });
        assert.equal((yield* harness.journal.read)[0]!.state, "interrupted");
      }
      assert.isFalse(yield* opened.runtime.hasPendingBackgroundWork!);
      assert.equal(remote.control.preparePosts, 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live.each(["storage", "revision"] as const)(
  "retains a definite rejection across a %s write failure without resubmitting",
  (failure) =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/data/kilo/auth.json`,
        '{"kilo":{"type":"api","key":"synthetic"}}',
      );
      const harness = yield* admissionHarness(remote, directory);
      const opened = yield* harness.open;
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(`${directory}/journal/intents.sqlite`)),
        (db) => Effect.sync(() => db.close()),
      );
      if (failure === "storage")
        db.exec(
          "CREATE TRIGGER reject_outcome BEFORE UPDATE ON intents WHEN json_extract(NEW.body, '$.submissionRejected') = 1 BEGIN SELECT RAISE(FAIL, 'fixture rejection write failure'); END",
        );
      remote.control.parkPrepare = true;
      const seen = yield* Deferred.make<void>();
      remote.control.prepareSeen = () => Deferred.doneUnsafe(seen, Effect.void);
      const starting = yield* opened.runtime
        .startTurn(harness.turn(opened.thread))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(seen);
      if (failure === "revision") {
        const other = yield* Journal.make(`${directory}/journal`);
        yield* other.save({ ...(yield* other.read)[0]!, admissionRecoveryFailures: 1 });
      }
      remote.control.parkedPrepare!.writeHead(400);
      remote.control.parkedPrepare!.end();
      yield* Fiber.join(starting);
      assert.equal(remote.control.preparePosts, 1);
      assert.equal(remote.control.listReads, 0);
      if (failure === "storage") {
        assert.isFalse(yield* opened.runtime.hasPendingBackgroundWork!);
        const saved = (yield* harness.journal.read)[0]!;
        assert.equal(saved.state, "admission_unknown");
        assert.equal(saved.submissionPhase, "post_attempted");
        yield* opened.runtime.startTurn(harness.turn(opened.thread, 2)).pipe(Effect.flip);
        // Restart cannot invent the rejection if no outcome could reach disk.
        const restarted = yield* admissionHarness(remote, directory);
        const next = yield* restarted.open;
        yield* next.runtime.startTurn(restarted.turn(next.thread, 2)).pipe(Effect.flip);
        yield* next.runtime
          .interruptTurn({ providerThread: next.thread, providerTurnId: saved.providerTurn.id })
          .pipe(Effect.flip);
        db.exec("DROP TRIGGER reject_outcome");
        yield* opened.runtime.readThreadSnapshot({ providerThread: opened.thread });
      }
      const saved = (yield* harness.journal.read)[0]!;
      assert.equal(saved.state, "failed");
      assert.isTrue(saved.submissionRejected);
      assert.equal(remote.control.listReads, 0);
      remote.control.parkPrepare = false;
      yield* opened.runtime.startTurn(harness.turn(opened.thread, 2));
      assert.equal(remote.control.preparePosts, 2);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live(
  "pauses immediately when recovered admission has the wrong branch",
  () =>
    Effect.gen(function* () {
      const { remote, directory } = yield* uncertainAdmission;
      remote.control.hideAdmissions = false;
      remote.control.sessionBranch = "other-branch";
      const harness = yield* admissionHarness(remote, directory);
      const opened = yield* harness.open;
      yield* opened.runtime.readThreadSnapshot({ providerThread: opened.thread });
      const saved = (yield* harness.journal.read)[0]!;
      assert.isTrue(saved.admissionRecoveryPaused);
      assert.equal(saved.admissionRecoveryFailures, 1);
      assert.equal(saved.state, "admission_unknown");
      assert.isNull(saved.binding);
      assert.isFalse(yield* opened.runtime.hasPendingBackgroundWork!);
      assert.equal(remote.control.preparePosts, 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);

it.live.each(["accepted", "storage", "storage-accepted"] as const)(
  "keeps a rejected follow-up safe during concurrent %s handling",
  (mode) =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      remote.control.status = "failed";
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/data/kilo`, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/data/kilo/auth.json`,
        '{"kilo":{"type":"api","key":"synthetic"}}',
      );
      const harness = yield* admissionHarness(remote, directory);
      const firstScope = yield* Scope.fork(yield* Effect.scope);
      const first = yield* harness.open.pipe(Effect.provideService(Scope.Scope, firstScope));
      const done = yield* Deferred.make<void>();
      yield* first.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(done, undefined) : Effect.void,
        ),
        Effect.forkIn(firstScope),
      );
      yield* first.runtime.startTurn(harness.turn(first.thread));
      yield* Deferred.await(done);
      yield* Scope.close(firstScope, Exit.void);
      const originalBinding = (yield* harness.journal.read)[0]!.binding;
      remote.control.status = "running";
      remote.control.parkSend = true;
      const second = yield* harness.open;
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(`${directory}/journal/intents.sqlite`)),
        (db) => Effect.sync(() => db.close()),
      );
      if (mode !== "accepted")
        db.exec(
          "CREATE TRIGGER reject_followup BEFORE UPDATE ON intents WHEN json_extract(NEW.body, '$.submissionRejected') = 1 BEGIN SELECT RAISE(FAIL, 'fixture rejection write failure'); END",
        );
      const seen = yield* Deferred.make<void>();
      remote.control.sendSeen = () => Deferred.doneUnsafe(seen, Effect.void);
      const starting = yield* second.runtime
        .startTurn(harness.turn(second.thread, 2))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(seen);
      const other = yield* Journal.make(`${directory}/journal`);
      if (mode === "accepted")
        yield* other.save({ ...(yield* other.read)[1]!, remoteState: "running" });
      remote.control.parkedSend!.writeHead(400);
      remote.control.parkedSend!.end();
      yield* Fiber.join(starting);
      const saved = (yield* other.read)[1]!;
      assert.equal(saved.state, "admission_unknown");
      assert.isNotTrue(saved.submissionRejected);
      assert.deepEqual(saved.binding, originalBinding);
      yield* second.runtime.startTurn(harness.turn(second.thread, 3)).pipe(Effect.flip);
      if (mode !== "accepted") {
        const stopped = yield* second.runtime
          .interruptTurn({ providerThread: second.thread, providerTurnId: saved.providerTurn.id })
          .pipe(Effect.flip);
        assert.include(stopped.message, "No remote interrupt was sent");
        assert.equal(remote.control.interruptPosts, 0);
        db.exec("DROP TRIGGER reject_followup");
        if (mode === "storage-accepted") {
          yield* other.save({ ...(yield* other.read)[1]!, remoteState: "running" });
          remote.control.interruptAccepted = true;
        }
        yield* second.runtime.interruptTurn({
          providerThread: second.thread,
          providerTurnId: saved.providerTurn.id,
        });
        const final = (yield* other.read)[1]!;
        assert.equal(final.state, mode === "storage" ? "failed" : "interrupted");
        assert.equal(final.submissionRejected === true, mode === "storage");
        assert.equal(remote.control.interruptPosts, mode === "storage" ? 0 : 1);
      } else {
        assert.equal(saved.remoteState, "running");
      }
      assert.equal(remote.control.preparePosts, 1);
      assert.equal(remote.control.sendPosts, 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  20_000,
);
