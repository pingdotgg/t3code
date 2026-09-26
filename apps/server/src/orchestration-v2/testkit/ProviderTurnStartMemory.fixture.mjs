import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeAssert from "node:assert/strict";
const root = process.argv[2];
const mode = process.argv[3];
const withHandoff = mode.startsWith("handoff");
const require = NodeModule.createRequire(root + "/apps/server/package.json");
const load = (name) => import(NodeURL.pathToFileURL(require.resolve("effect/" + name)));
const [Effect, Layer, FileSystem] = await Promise.all([
  load("Effect"),
  load("Layer"),
  load("FileSystem"),
]);
const app = (file) => import(NodeURL.pathToFileURL(root + "/apps/server/src/" + file + ".ts"));
const [Start, Projection, Run, Sessions, Policy, Id, Sink, Handoff, Git, Project, Auth] =
  await Promise.all([
    app("orchestration-v2/ProviderTurnStartService"),
    app("orchestration-v2/ProjectionStore"),
    app("orchestration-v2/RunExecutionService"),
    app("orchestration-v2/ProviderSessionManager"),
    app("orchestration-v2/RuntimePolicy"),
    app("orchestration-v2/IdAllocator"),
    app("orchestration-v2/EventSink"),
    app("orchestration-v2/ContextHandoffService"),
    app("git/GitWorkflowService"),
    app("project/ProjectService"),
    app("provider/Services/ProviderAuthService"),
  ]);
let current;
let fullReads = 0;
const liveRuns = [];
const refs = [];
const checkpoints = [];
const count = Number(process.argv[4] ?? 4);
const bytes = Number(process.argv[5] ?? 32768);
const session = {
  driver: "codex",
  providerSession: { id: "session", driver: "codex" },
  resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
  startTurn: () =>
    mode === "handoff-failure" ? Effect.fail("Synthetic startup failure") : Effect.void,
  compactThread: () => Effect.void,
};
const dependencies = Layer.mergeAll(
  Layer.mock(Handoff.ContextHandoffServiceV2)({}),
  Id.layer,
  FileSystem.layerNoop({}),
  Layer.mock(Git.GitWorkflowService)({}),
  Layer.mock(Project.ProjectService)({}),
  Layer.mock(Auth.ProviderAuthService)({}),
  Layer.mock(Projection.ProjectionStoreV2)({
    getThreadProjection: () =>
      Effect.sync(() => {
        fullReads++;
        throw new Error("full transcript read");
      }),
    hasUnpairedRunInterruptRequest: () => Effect.succeed(false),
    getTurnStartContext: () =>
      Effect.sync(() => {
        fullReads++;
        return { ...current, hasConversation: true };
      }),
    getTurnStartHistory: () => Effect.sync(() => current.turnItems),
    getRuntimeRecoveryProjection: () => Effect.sync(() => current),
  }),
  Layer.mock(Sessions.ProviderSessionManagerV2)({ open: () => Effect.succeed(session) }),
  Layer.mock(Policy.RuntimePolicyV2)({
    resolve: () =>
      Effect.succeed({ cwd: "/synthetic", interactionMode: "default", runtimeMode: "full-access" }),
  }),
  Layer.mock(Run.RunExecutionServiceV2)({
    startRootRun: (input) =>
      Effect.gen(function* () {
        liveRuns.push(input);
        const turnInput = { ...input, message: input.message };
        const result = yield* Effect.exit(
          mode === "handoff-compact"
            ? input.session.compactThread(turnInput)
            : input.session.startTurn(turnInput),
        );
        NodeAssert.equal(result._tag, mode === "handoff-failure" ? "Failure" : "Success");
      }),
  }),
  Layer.mock(Sink.EventSinkV2)({
    write: () => Effect.succeed([]),
    writeIfRunCurrent: ({ events }) =>
      Effect.sync(() => {
        for (const event of events)
          if (event.type === "run.updated") current.runs = [event.payload];
        return { committed: true, storedEvents: [] };
      }),
  }),
);
function fixture(index) {
  const runId = "run:" + index;
  const history = JSON.parse(
    JSON.stringify({
      id: "historical:" + index,
      threadId: "thread",
      runId: null,
      providerThreadId: "provider",
      status: "completed",
      type: "command_execution",
      output: NodeCrypto.randomBytes(bytes).toString("hex"),
    }),
  );
  refs.push(new WeakRef(history));
  return {
    thread: { id: "thread", projectId: "project", branch: null, worktreePath: null },
    runs: [
      {
        id: runId,
        threadId: "thread",
        ordinal: 1,
        providerInstanceId: "instance",
        modelSelection: { instanceId: "instance", model: "synthetic" },
        providerThreadId: "provider",
        userMessageId: "message",
        rootNodeId: "root",
        activeAttemptId: "attempt",
        status: "starting",
        startedAt: null,
      },
    ],
    nodes: [{ id: "root", checkpointScopeId: "scope" }],
    attempts: [{ id: "attempt", runId, providerThreadId: "provider" }],
    providerThreads: [
      {
        id: "provider",
        driver: "codex",
        providerSessionId: "session",
        nativeThreadRef: { nativeId: "native", driver: "codex", strength: "strong" },
        contextUsage: { usedTokens: 0, maxTokens: 128000 },
        handoffIds: [],
      },
    ],
    messages: [{ id: "message", text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: "scope" }],
    contextHandoffs: withHandoff
      ? [
          {
            id: "handoff",
            threadId: "thread",
            targetRunId: runId,
            toProviderThreadId: "provider",
            fromProviderThreadIds: ["provider"],
            coveredRunOrdinals: { from: 1, to: 1 },
            status: "ready",
            strategy: "full_thread_summary",
            summaryText: "Synthetic summary",
            handoffIds: [],
          },
        ]
      : [],
    contextTransfers: [],
    providerSessions: [],
    providerTurns: [],
    subagents: [],
    turnItems: [history],
  };
}
await Effect.runPromise(
  Effect.gen(function* () {
    const service = yield* Start.ProviderTurnStartServiceV2;
    for (let i = 0; i < count; i++) {
      current = fixture(i);
      yield* service.start({ threadId: "thread", runId: "run:" + i });
      // The run worker must keep checking current durable state, not its startup copy.
      const controls = liveRuns.at(-1);
      current = { ...current, turnItems: [] };
      NodeAssert.equal(yield* controls.shouldStartProviderTurn(), true);
      NodeAssert.equal(yield* controls.shouldFinalizeRun(), true);
      const liveRun = current.runs[0];
      current = { ...current, runs: [{ ...liveRun, activeAttemptId: "replacement" }] };
      NodeAssert.equal(yield* controls.shouldStartProviderTurn(), false);
      NodeAssert.equal(yield* controls.shouldFinalizeRun(), false);
      current = { ...current, runs: [{ ...liveRun, status: "completed" }] };
      NodeAssert.equal(yield* controls.shouldFinalizeRun(), false);
      NodeAssert.deepEqual(yield* controls.loadInheritedBackgroundTurnItems(), []);
      NodeAssert.equal(fullReads, i + 1);
      NodeAssert.equal(yield* controls.hasUnpairedRunInterruptRequest(), false);
      NodeAssert.equal(fullReads, i + 1);
      current = null;
      if (i === Math.floor(count / 2) - 1 || i === count - 1) {
        yield* Effect.promise(async () => {
          for (let j = 0; j < 3; j++) {
            await new Promise(setImmediate);
            global.gc();
          }
          checkpoints.push({
            runs: liveRuns.length,
            payloadMiB: ((i + 1) * bytes * 2) / 1048576,
            retained: refs.filter((ref) => ref.deref()).length,
            heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
          });
        });
      }
    }
  }).pipe(Effect.provide(Start.layer.pipe(Layer.provide(dependencies)))),
);
console.log(JSON.stringify({ checkpoints }));
