import { assert, it } from "@effect/vitest";
import { type MilestoneEvent, MilestoneId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as MilestoneHub from "./MilestoneHub.ts";

const settled = (
  id: string,
  options: { readonly child?: boolean; readonly project?: string } = {},
): MilestoneEvent => ({
  id: MilestoneId.make(id),
  type: "thread.run_settled",
  occurredAt: "2026-11-20T00:00:00.000Z",
  projectId: ProjectId.make(options.project ?? "project:a"),
  threadId: ThreadId.make(`thread:${id}`),
  parentThreadId: options.child === true ? ThreadId.make("thread:parent") : null,
  actor: { type: "agent" },
  isSubagentChild: options.child === true,
  runId: RunId.make(`run:${id}`),
  outcome: "completed",
});
const workflowEnded = (id: string, workflowRunId: string): MilestoneEvent => ({
  id: MilestoneId.make(id),
  type: "workflow.run_ended",
  occurredAt: "2026-11-20T00:00:00.000Z",
  projectId: null,
  threadId: null,
  parentThreadId: null,
  actor: { type: "system" },
  isSubagentChild: false,
  workflowRunId,
  workflow: "review",
  runTitle: "Review",
  parentWorkflowRunId: null,
  outcome: "completed",
  detail: null,
});
const ids = (events: Iterable<MilestoneEvent>) => [...events].map((event) => event.id);

it.effect("fans out to every subscriber, muting subagent children unless asked for", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const muted = yield* hub.subscribe();
    const everything = yield* hub.subscribe({ includeSubagentChildren: true });
    const projectB = yield* hub.subscribe({ projectIds: [ProjectId.make("project:b")] });
    const runR1 = yield* hub.subscribe({ workflowRunIds: ["r1"] });

    yield* hub.publish(settled("a"));
    yield* hub.publish(settled("child", { child: true }));
    // A repeat of an id is the same milestone.
    yield* hub.publish(settled("a"));
    yield* hub.publish(settled("b", { project: "project:b" }));
    yield* hub.publish(workflowEnded("w0", "r0"));
    yield* hub.publish(workflowEnded("w1", "r1"));

    assert.deepStrictEqual(ids(yield* Stream.runCollect(Stream.take(muted, 4))), [
      "a",
      "b",
      "w0",
      "w1",
    ]);
    assert.deepStrictEqual(ids(yield* Stream.runCollect(Stream.take(everything, 3))), [
      "a",
      "child",
      "b",
    ]);
    // A workflow milestone has no project, and a thread milestone no workflow run.
    assert.deepStrictEqual(ids(yield* Stream.runCollect(Stream.take(projectB, 1))), ["b"]);
    assert.deepStrictEqual(ids(yield* Stream.runCollect(Stream.take(runR1, 1))), ["w1"]);
    assert.deepStrictEqual(ids((yield* hub.recent()).events), ["a", "b", "w0", "w1"]);
  }).pipe(Effect.scoped, Effect.provide(MilestoneHub.layer)),
);

it.effect("pages forward from a kept id and says when the answer is cut short", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    for (let index = 0; index < 1_005; index++) yield* hub.publish(settled(`e${index}`));

    const after = yield* hub.recent({ sinceId: MilestoneId.make("e1000"), limit: 3 });
    assert.deepStrictEqual(ids(after.events), ["e1001", "e1002", "e1003"]);
    assert.isTrue(after.truncated);
    const rest = yield* hub.recent({ sinceId: MilestoneId.make("e1003") });
    assert.deepStrictEqual([ids(rest.events), rest.truncated], [["e1004"], false]);

    // The oldest fell out of the buffer, so a caller that last saw it missed some.
    const gone = yield* hub.recent({ sinceId: MilestoneId.make("e2"), limit: 2 });
    assert.deepStrictEqual([ids(gone.events), gone.truncated], [["e1003", "e1004"], true]);
    const newest = yield* hub.recent({ limit: 1_000 });
    assert.deepStrictEqual(
      [newest.events.length, newest.events[0]?.id, newest.truncated],
      [1_000, "e5", false],
    );
  }).pipe(Effect.provide(MilestoneHub.layer)),
);

it.effect("skips expired milestones even when they arrive after newer ones", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    yield* TestClock.adjust("10 minutes");
    const { cursor } = yield* hub.read({ cursor: null, limit: 1 });
    yield* hub.publish({ ...settled("fresh"), occurredAt: "1970-01-01T00:10:00.000Z" });
    yield* hub.publish({ ...settled("expired"), occurredAt: "1970-01-01T00:08:59.000Z" });
    yield* hub.publish({ ...settled("at-cutoff"), occurredAt: "1970-01-01T00:09:00.000Z" });

    const first = yield* hub.read({ cursor, maxAgeMs: 60_000, limit: 1 });
    assert.deepStrictEqual(ids(first.events.map(({ event }) => event)), ["fresh"]);
    assert.isTrue(first.hasMore);
    assert.isTrue(first.truncated);
    const rest = yield* hub.read({ cursor: first.cursor, maxAgeMs: 60_000, limit: 1 });
    assert.deepStrictEqual(ids(rest.events.map(({ event }) => event)), ["at-cutoff"]);
    assert.isFalse(rest.hasMore);
  }).pipe(Effect.provide(MilestoneHub.layer)),
);

it.effect("a follower's replay ends at the position it checked, past its last match", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const { cursor } = yield* hub.read({ cursor: null, limit: 1 });
    yield* hub.publish(settled("a"));
    yield* hub.publish(settled("b", { project: "project:b" }));

    const { items } = yield* hub.follow({
      cursor,
      filter: { projectIds: [ProjectId.make("project:a")] },
    });
    const [milestone, position] = yield* Stream.runCollect(Stream.take(items, 2));
    assert.strictEqual(milestone?._tag === "Milestone" ? milestone.event.id : undefined, "a");
    assert.strictEqual(position?._tag, "Position");
    assert.strictEqual((yield* hub.read({ cursor: null, limit: 1 })).cursor, position?.cursor);
  }).pipe(Effect.scoped, Effect.provide(MilestoneHub.layer)),
);

it.effect("tells a follower that fell behind the subscriber backlog where its gap is", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const { items } = yield* hub.follow({ cursor: null });
    // Published before the follower reads, so the backlog drops the oldest.
    for (let index = 0; index < 300; index++) yield* hub.publish(settled(`e${index}`));

    const [gap, first] = yield* Stream.runCollect(Stream.take(items, 2));
    assert.strictEqual(gap?._tag, "Gap");
    assert.strictEqual(first?._tag === "Milestone" ? first.event.id : undefined, "e44");
  }).pipe(Effect.scoped, Effect.provide(MilestoneHub.layer)),
);
