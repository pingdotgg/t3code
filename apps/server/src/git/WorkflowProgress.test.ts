import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { GitManagerError, type GitWorkflowProgress } from "@t3tools/contracts";
import { make } from "./WorkflowProgress.ts";

it.layer(NodeServices.layer)("workflow progress", (it) => {
  it.effect.each(["completed", "failed", "cancelled"] as const)(
    "streams live steps and retains %s state scoped to the checkout",
    (outcome) =>
      Effect.gen(function* () {
        const progress = yield* make;
        const queue = yield* Queue.unbounded<GitWorkflowProgress | null>();
        yield* progress.subscribe("/repo/one").pipe(
          Stream.runForEach((value) => Queue.offer(queue, value)),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(queue)).toBeNull();
        const gate = yield* Deferred.make<void>();
        const job = yield* progress
          .run("/repo/one", "logical_commits", "Preparing", (report) =>
            Effect.gen(function* () {
              yield* report({
                label: "Planning",
                steps: [{ id: "plan", group: "Logical commits", label: "Plan", state: "running" }],
              });
              yield* Deferred.await(gate);
              if (outcome === "failed")
                return yield* new GitManagerError({
                  operation: "test",
                  cwd: "/repo/one",
                  detail: "Failed",
                });
            }),
          )
          .pipe(Effect.forkScoped);
        expect((yield* Queue.take(queue))?.state).toBe("running");
        expect((yield* Queue.take(queue))?.label).toBe("Planning");
        expect(
          yield* progress.subscribe("/repo/two").pipe(Stream.take(1), Stream.runCollect),
        ).toEqual([null]);
        if (outcome === "cancelled") yield* Fiber.interrupt(job);
        else {
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.await(job);
        }
        const settled = yield* Queue.take(queue);
        const final = settled;
        expect(final?.state).toBe(outcome);
        expect(final?.steps[0]?.state).toBe(
          outcome === "completed" ? "completed" : outcome === "cancelled" ? "skipped" : "failed",
        );
        expect(
          yield* progress.subscribe("/repo/one").pipe(Stream.take(1), Stream.runCollect),
        ).toEqual([final]);
      }).pipe(Effect.scoped),
  );
});
