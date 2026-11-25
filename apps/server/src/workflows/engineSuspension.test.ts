import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";

// Proves our effect patch: a wake landing while a failed step cleans up must not replay the run.
it.effect("a failed activity keeps its run failed when a wake preempts it mid-cleanup", () =>
  Effect.gen(function* () {
    let badRuns = 0;
    const badFailing = yield* Latch.make();
    const siblingStarted = yield* Latch.make();
    const sibling = yield* Latch.make();
    const Answer = DurableDeferred.make("answer");
    const Doubting = Workflow.make("Doubting", {
      payload: {},
      idempotencyKey: () => "doubting",
    }).annotate(Workflow.SuspendOnFailure, true);
    const DoubtingLayer = Doubting.toLayer(() =>
      Effect.all(
        [
          Activity.make({
            name: "bad",
            execute: Effect.suspend(() => {
              badRuns++;
              return siblingStarted.await.pipe(
                Effect.andThen(badFailing.open),
                Effect.andThen(Effect.die("the dependency is down")),
              );
            }),
          }),
          Activity.make({
            name: "sibling",
            execute: Effect.andThen(siblingStarted.open, sibling.await),
          }),
          DurableDeferred.await(Answer),
        ],
        { concurrency: "unbounded" },
      ),
    );
    yield* Effect.gen(function* () {
      const executionId = yield* Doubting.execute({}, { discard: true });
      yield* badFailing.await;
      // `bad` has failed and its cleanup waits on `sibling`: the answer's wake preempts the run.
      const wake = yield* Effect.forkChild(
        DurableDeferred.succeed(Answer, {
          token: DurableDeferred.tokenFromExecutionId(Answer, { workflow: Doubting, executionId }),
          value: undefined,
        }),
      );
      yield* sibling.open;
      // Outside the run, `succeed` returns once the wake, its automatic resume included, is done.
      yield* Fiber.join(wake);
      const result = yield* Doubting.poll(executionId);
      // Failed, so the automatic wake left it parked for an explicit resume.
      assert.isTrue(
        Option.isSome(result) && result.value._tag === "Suspended" && result.value.failed,
      );
      assert.strictEqual(badRuns, 1, "only a resume runs the failed activity again");
    }).pipe(Effect.provide(DoubtingLayer.pipe(Layer.provideMerge(WorkflowEngine.layerMemory))));
  }),
);
