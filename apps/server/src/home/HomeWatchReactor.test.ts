import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MilestoneEvent,
  MilestoneId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as MilestoneHub from "../milestones/MilestoneHub.ts";
import * as HomeService from "./HomeService.ts";
import { makeOrchestration, model, provideHome, type SentMessage } from "./HomeTestkit.ts";
import * as HomeWatchReactor from "./HomeWatchReactor.ts";

const settled = (id: string, threadId: string): MilestoneEvent => ({
  id: MilestoneId.make(id),
  type: "thread.run_settled",
  occurredAt: "2026-11-20T00:00:00.000Z",
  projectId: ProjectId.make("project:a"),
  threadId: ThreadId.make(threadId),
  parentThreadId: null,
  actor: { type: "agent" },
  isSubagentChild: false,
  runId: RunId.make(`run:${id}`),
  outcome: "completed",
});

const needsInput = (id: string, threadId: string): MilestoneEvent => ({
  id: MilestoneId.make(id),
  type: "thread.needs_input",
  occurredAt: "2026-11-20T00:00:00.000Z",
  projectId: ProjectId.make("project:a"),
  threadId: ThreadId.make(threadId),
  parentThreadId: null,
  actor: { type: "agent" },
  isSubagentChild: false,
  requestId: `request:${id}` as never,
  kind: "approval",
});

const run = <A, E>(
  body: (
    sends: Queue.Queue<SentMessage>,
  ) => Effect.Effect<A, E, HomeService.HomeService | MilestoneHub.MilestoneHub>,
) =>
  Effect.gen(function* () {
    const sends = yield* Queue.unbounded<SentMessage>();
    const orchestration = makeOrchestration(sends);
    return yield* Effect.gen(function* () {
      yield* (yield* HomeWatchReactor.HomeWatchReactor).start();
      return yield* body(sends);
    }).pipe(
      Effect.provide(
        HomeWatchReactor.layer.pipe(
          Layer.provideMerge(MilestoneHub.layer),
          Layer.provideMerge(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("env:here")),
            }),
          ),
        ),
      ),
      provideHome(orchestration),
    );
  });

it.effect(
  "wakes Home once per watched milestone, ignoring unwatched targets and ending on settle",
  () =>
    run((sends) =>
      Effect.gen(function* () {
        const home = yield* HomeService.HomeService;
        const hub = yield* MilestoneHub.MilestoneHub;
        const homeThread = (yield* home.enable({ modelSelection: model })).threadId;
        yield* home.addWatch(homeThread, {
          threadId: ThreadId.make("thread:a"),
          reason: "launched",
        });
        yield* home.addWatch(homeThread, { threadId: ThreadId.make("thread:b"), reason: "manual" });

        yield* hub.publish(settled("unwatched", "thread:other"));
        yield* hub.publish(needsInput("ask", "thread:a"));
        const asked = yield* Queue.take(sends);
        assert.deepStrictEqual([asked.threadId, asked.commandId], [homeThread, "home-wake:ask"]);
        assert.include(asked.text, "waits for an approval");

        yield* hub.publish(settled("done", "thread:a"));
        assert.strictEqual((yield* Queue.take(sends)).commandId, "home-wake:done");
        // The settled thread's watch ended; a later turn there is no longer news.
        yield* hub.publish(settled("again", "thread:a"));
        yield* hub.publish(needsInput("b-ask", "thread:b"));
        assert.strictEqual((yield* Queue.take(sends)).commandId, "home-wake:b-ask");
        assert.deepStrictEqual(
          (yield* home.read).watches.map((watch) => ("threadId" in watch ? watch.threadId : null)),
          [ThreadId.make("thread:b")],
        );
      }),
    ),
);

it.effect("stays silent while Home is off", () =>
  run((sends) =>
    Effect.gen(function* () {
      const home = yield* HomeService.HomeService;
      const hub = yield* MilestoneHub.MilestoneHub;
      const first = (yield* home.enable({ modelSelection: model })).threadId;
      yield* home.addWatch(first, { threadId: ThreadId.make("thread:a"), reason: "launched" });
      yield* home.disable;
      yield* hub.publish(settled("while-off", "thread:a"));

      const second = (yield* home.enable({})).threadId;
      yield* home.addWatch(second, { threadId: ThreadId.make("thread:a"), reason: "manual" });
      yield* hub.publish(settled("back-on", "thread:a"));
      const woke = yield* Queue.take(sends);
      assert.deepStrictEqual([woke.threadId, woke.commandId], [second, "home-wake:back-on"]);
    }),
  ),
);
