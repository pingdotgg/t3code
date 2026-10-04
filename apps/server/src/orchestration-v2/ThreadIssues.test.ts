import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MAX_THREAD_ISSUES,
  OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider session needed for issue links"),
} as ProviderAdapterV2Shape;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const testLayer = Layer.mergeAll(
  stores,
  ProjectionMaintenance.layer.pipe(Layer.provide(stores), Layer.provide(SqlitePersistenceMemory)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-issues" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
  ),
);
const issue = (number: number): ThreadIssueLink => ({
  provider: "github",
  repository: "t3tools/t3code",
  number,
  url: `https://github.com/t3tools/t3code/issues/${number}`,
  title: `Issue ${number}`,
});
const createThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:issues"),
      title: "Issue work",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

it("rejects linking and unlinking in one metadata command", () => {
  const decode = Schema.decodeUnknownOption(OrchestrationV2Command);
  assert.equal(
    decode({
      type: "thread.metadata.update",
      commandId: "ambiguous",
      threadId: "thread:issues",
      issueLink: issue(1),
      issueUnlink: issue(2),
    })._tag,
    "None",
  );
});

it.layer(testLayer)("V2 thread issue links", (it) => {
  it.effect("keeps the same issue number on different hosts and unlinks by normalized URL", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:issues:hosts");
      const publicIssue = issue(1);
      const enterpriseIssue = {
        ...publicIssue,
        url: "https://github.acme.test/t3tools/t3code/issues/1",
      };
      yield* createThread(threadId);
      for (const [index, linkedIssue] of [publicIssue, enterpriseIssue].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`host:link:${index}`),
          threadId,
          issueLink: linkedIssue,
        });
      }
      assert.deepEqual((yield* projections.getThread(threadId)).issues, [
        publicIssue,
        enterpriseIssue,
      ]);
      for (const [commandId, change, detail] of [
        [
          "host:duplicate",
          { issueLink: { ...enterpriseIssue, url: `${enterpriseIssue.url}?source=web#comment` } },
          "already linked",
        ],
        [
          "host:missing",
          {
            issueUnlink: { ...publicIssue, url: "https://other.acme.test/t3tools/t3code/issues/1" },
          },
          "not linked",
        ],
      ] as const) {
        const error = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(commandId),
            threadId,
            ...change,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.include(String("cause" in error ? error.cause : ""), detail);
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("host:unlink"),
        threadId,
        issueUnlink: { ...enterpriseIssue, url: `${enterpriseIssue.url}#comment` },
      });
      assert.deepEqual((yield* projections.getThread(threadId)).issues, [publicIssue]);
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.issues, [publicIssue]);
    }),
  );

  it.effect("keeps legacy unlink without a URL limited to its first matching issue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:issues:legacy-hosts");
      const publicIssue = issue(1);
      const enterpriseIssue = {
        ...publicIssue,
        url: "https://github.acme.test/t3tools/t3code/issues/1",
      };
      yield* createThread(threadId);
      for (const [index, linkedIssue] of [publicIssue, enterpriseIssue].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`legacy:host:link:${index}`),
          threadId,
          issueLink: linkedIssue,
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("legacy:host:unlink"),
        threadId,
        issueUnlink: { provider: "github", repository: "T3Tools/T3Code", number: 1 },
      });
      assert.deepEqual((yield* projections.getThread(threadId)).issues, [enterpriseIssue]);
    }),
  );

  it.effect(
    "persists links in thread and shell reads, replays them, and unlinks only the selected issue",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const threadId = ThreadId.make("thread:issues:replay");
        yield* createThread(threadId);
        for (const number of [10, 11]) {
          const command = {
            type: "thread.metadata.update" as const,
            commandId: CommandId.make(`link:${number}`),
            threadId,
            issueLink: issue(number),
          };
          yield* orchestrator.dispatch(command);
          yield* orchestrator.dispatch(command);
        }
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename:issues"),
          threadId,
          title: "Renamed",
        });
        assert.deepEqual((yield* projections.getThreadProjection(threadId)).thread.issues, [
          issue(10),
          issue(11),
        ]);
        assert.deepEqual((yield* projections.getThreadShell(threadId))?.issues, [
          issue(10),
          issue(11),
        ]);
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.deepEqual((yield* projections.getThread(threadId)).issues, [issue(10), issue(11)]);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("unlink:10"),
          threadId,
          issueUnlink: { provider: "github", repository: "T3Tools/T3Code", number: 10 },
        });
        assert.deepEqual((yield* projections.getThread(threadId)).issues, [issue(11)]);
        assert.deepEqual((yield* projections.getThreadShell(threadId))?.issues, [issue(11)]);
      }),
  );

  it.effect("rejects duplicate links, missing unlinks, and links above the limit", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:issues:limit");
      yield* createThread(threadId);
      const thread = yield* projections.getThread(threadId);
      yield* projections.apply({
        id: EventId.make("seed:issues"),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: thread.updatedAt,
        payload: {
          ...thread,
          issues: Array.from({ length: MAX_THREAD_ISSUES }, (_, index) => issue(index + 1)),
        },
      });
      for (const [commandId, change, detail] of [
        [
          "duplicate",
          { issueLink: { ...issue(7), repository: "T3Tools/T3Code" } },
          "already linked",
        ],
        ["missing", { issueUnlink: issue(101) }, "not linked"],
        ["limit", { issueLink: issue(101) }, "100 linked issues"],
      ] as const) {
        const error = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(commandId),
            threadId,
            ...change,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.include(String("cause" in error ? error.cause : ""), detail);
      }
      assert.equal((yield* projections.getThread(threadId)).issues?.length, MAX_THREAD_ISSUES);
    }),
  );
});
