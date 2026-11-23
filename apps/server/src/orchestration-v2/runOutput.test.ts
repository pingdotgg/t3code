import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunId,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  checkOutput,
  latestOwedOutputRun,
  outputRequestProblem,
  resolveOwedOutputRun,
  runRequiresRunScopedMcp,
} from "./runOutput.ts";

const open = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
const closed = { ...open, additionalProperties: false };

it.effect("a closed schema turns down a key it does not name, and an open one keeps it", () =>
  Effect.gen(function* () {
    const extra = '{"verdict":"merge","note":"kept"}';
    assert.deepStrictEqual(yield* checkOutput(open, extra), Result.succeed(JSON.parse(extra)));
    const rejected = yield* checkOutput(closed, extra);
    assert.isTrue(Result.isFailure(rejected));
    assert.isTrue(Result.isSuccess(yield* checkOutput(closed, '{"verdict":"merge"}')));
  }),
);

it("a command its provider runs itself cannot be asked for a result", () => {
  for (const text of ["/compact", "/goal Review the changes"]) {
    assert.include(outputRequestProblem(open, { text }) ?? "", "command");
  }
  assert.isNull(outputRequestProblem(open, { text: "Review the changes" }));
});

it.effect("owed output follows only the newest started request inside the current context", () =>
  Effect.gen(function* () {
    const makeRun = (
      id: string,
      ordinal: number,
      fields: Partial<OrchestrationV2Run> = {},
    ): OrchestrationV2Run =>
      ({
        id: RunId.make(id),
        ordinal,
        status: "completed",
        startedAt: null,
        userMessageId: MessageId.make(`msg:${id}`),
        ...fields,
      }) as unknown as OrchestrationV2Run;

    const asked = makeRun("run:asked", 1, { outputSchema: open });
    const queued = makeRun("run:queued", 2, { status: "queued", outputSchema: open });
    const cancelledNeverStarted = makeRun("run:cancelled", 3, {
      status: "cancelled",
      startedAt: null,
      outputSchema: open,
    });
    assert.equal(latestOwedOutputRun([asked, queued, cancelledNeverStarted])?.id, asked.id);

    // Once a newer started request answers, the earlier unanswered request no longer owes output.
    const correction = makeRun("run:correction", 4, {
      outputSchema: open,
      output: { value: { verdict: "merge" }, submittedAt: "2026-01-01T00:00:00.000Z" },
    });
    const plain = makeRun("run:plain", 5, { status: "running" });
    let contextLoads = 0;
    const loadContext = (runs: ReadonlyArray<OrchestrationV2Run>, scheduled?: MessageId) => () => {
      contextLoads += 1;
      const turnItems =
        scheduled === undefined
          ? []
          : ([
              {
                type: "user_message",
                messageId: scheduled,
                scheduledTaskId: ScheduledTaskId.make("sched:1"),
              },
            ] as unknown as ReadonlyArray<OrchestrationV2TurnItem>);
      return Effect.succeed({ runs, turnItems });
    };
    assert.isUndefined(latestOwedOutputRun([asked, correction, plain]));
    assert.isFalse(
      yield* runRequiresRunScopedMcp(
        [asked, correction, plain],
        plain.id,
        correction.id,
        loadContext([asked, correction, plain]),
      ),
    );
    assert.equal(contextLoads, 0);

    // A scheduled fresh-context run keeps the owed run reachable; an unscheduled one forgets it.
    const scheduledFresh = makeRun("run:sched-fresh", 2, {
      status: "completed",
      freshContext: true,
    });
    const schedRuns = [asked, scheduledFresh, plain];
    assert.equal(
      (yield* resolveOwedOutputRun(schedRuns, loadContext(schedRuns, scheduledFresh.userMessageId)))
        ?.id,
      asked.id,
    );
    assert.isTrue(
      yield* runRequiresRunScopedMcp(
        schedRuns,
        plain.id,
        undefined,
        loadContext(schedRuns, scheduledFresh.userMessageId),
      ),
    );

    const fresh = makeRun("run:fresh", 3, { status: "running", freshContext: true });
    const freshRuns = [asked, fresh];
    assert.isUndefined(yield* resolveOwedOutputRun(freshRuns, loadContext(freshRuns)));
    assert.isFalse(
      yield* runRequiresRunScopedMcp(freshRuns, fresh.id, undefined, loadContext(freshRuns)),
    );
  }),
);
