import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { performHandoff } from "./HandoffService.ts";

const parentThreadId = ThreadId.make("parent-thread");

const parentShell: OrchestrationThreadShell = {
  id: parentThreadId,
  projectId: ProjectId.make("project-1"),
  title: "Parent thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5",
  },
  runtimeMode: "auto",
  interactionMode: "plan",
  branch: "feature/parent-branch",
  worktreePath: "/tmp/parent-worktree",
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const makeHarnessLayer = (input: {
  readonly parent: OrchestrationThreadShell | undefined;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly failOnType?: OrchestrationCommand["type"];
}) =>
  Layer.mergeAll(
    Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.suspend(() => {
          if (command.type === input.failOnType) {
            return Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "test-induced dispatch failure",
              }),
            );
          }
          input.dispatched.push(command);
          return Effect.succeed({ sequence: input.dispatched.length });
        }),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ProjectionSnapshotQuery, {
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      getSnapshotSequence: () => Effect.die("unused"),
      getCounts: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
      getProjectShellById: () => Effect.die("unused"),
      getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
      getThreadShellById: (threadId) =>
        Effect.succeed(
          input.parent && threadId === input.parent.id ? Option.some(input.parent) : Option.none(),
        ),
      getThreadDetailById: () => Effect.die("unused"),
      getThreadDetailSnapshot: () => Effect.die("unused"),
      searchThreads: () => Effect.die("unused"),
      getThreadCheckpointContext: () => Effect.die("unused"),
      getFullThreadDiffContext: () => Effect.die("unused"),
    }),
    NodeServices.layer,
  );

it.effect("creates, seeds, and records lineage for the child thread", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];

    const result = yield* performHandoff({
      parentThreadId,
      request: { name: "Fix flaky auth tests", summary: "Goal: fix the flaky tests." },
    }).pipe(Effect.provide(makeHarnessLayer({ parent: parentShell, dispatched })));

    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["thread.create", "thread.turn.start", "thread.activity.append", "thread.activity.append"],
    );

    const create = dispatched[0];
    assert(create?.type === "thread.create");
    assert.equal(create.threadId, result.threadId);
    assert.equal(create.projectId, parentShell.projectId);
    assert.equal(create.title, "Fix flaky auth tests");
    // Carry rule: model/permission/interaction mode carry from the parent;
    // branch and worktree never do.
    assert.deepEqual(create.modelSelection, parentShell.modelSelection);
    assert.equal(create.runtimeMode, parentShell.runtimeMode);
    assert.equal(create.interactionMode, parentShell.interactionMode);
    assert.equal(create.branch, null);
    assert.equal(create.worktreePath, null);

    const turnStart = dispatched[1];
    assert(turnStart?.type === "thread.turn.start");
    assert.equal(turnStart.threadId, result.threadId);
    assert.equal(turnStart.message.text, "Goal: fix the flaky tests.");
    assert.equal(turnStart.message.role, "user");
    // The model-chosen name is the title; no titleSeed means the auto-titler
    // can never replace it.
    assert.equal(turnStart.titleSeed, undefined);

    const parentActivity = dispatched[2];
    assert(parentActivity?.type === "thread.activity.append");
    assert.equal(parentActivity.threadId, parentThreadId);
    assert.equal(parentActivity.activity.kind, "handoff.created");
    assert.deepEqual(parentActivity.activity.payload, {
      childThreadId: result.threadId,
      childTitle: "Fix flaky auth tests",
    });

    const childActivity = dispatched[3];
    assert(childActivity?.type === "thread.activity.append");
    assert.equal(childActivity.threadId, result.threadId);
    assert.equal(childActivity.activity.kind, "handoff.received");
    assert.deepEqual(childActivity.activity.payload, {
      parentThreadId,
      parentTitle: "Parent thread",
    });
  }),
);

it.effect("fails with HandoffParentNotFoundError when the parent is missing", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];

    const error = yield* performHandoff({
      parentThreadId,
      request: { name: "Anything", summary: "Anything" },
    }).pipe(Effect.provide(makeHarnessLayer({ parent: undefined, dispatched })), Effect.flip);

    assert.equal(error._tag, "HandoffParentNotFoundError");
    assert.deepEqual(dispatched, []);
  }),
);

it.effect("treats an archived parent as not handoffable", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];

    const error = yield* performHandoff({
      parentThreadId,
      request: { name: "Anything", summary: "Anything" },
    }).pipe(
      Effect.provide(
        makeHarnessLayer({
          parent: { ...parentShell, archivedAt: "2026-01-02T00:00:00.000Z" },
          dispatched,
        }),
      ),
      Effect.flip,
    );

    assert.equal(error._tag, "HandoffParentNotFoundError");
    assert.deepEqual(dispatched, []);
  }),
);

it.effect("deletes the freshly created child when the seed turn fails to start", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];

    const error = yield* performHandoff({
      parentThreadId,
      request: { name: "Doomed", summary: "This will not start." },
    }).pipe(
      Effect.provide(
        makeHarnessLayer({
          parent: parentShell,
          dispatched,
          failOnType: "thread.turn.start",
        }),
      ),
      Effect.flip,
    );

    assert.equal(error._tag, "HandoffDispatchError");
    assert(error._tag === "HandoffDispatchError" && error.stage === "turn-start");
    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["thread.create", "thread.delete"],
    );
  }),
);
