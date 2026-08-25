/**
 * The shared typed Step Functions program exercised by BOTH the live
 * `StateMachine.fromProgram` test and the in-process `Sfn.simulate` unit
 * test — one AST, two interpreters.
 *
 * Covers the flagship combinators: `Sfn.gen` sequencing, `Sfn.invoke`
 * (Lambda Task + retry), `Sfn.forEach` (inline Map), `Sfn.when` (Choice),
 * and `Sfn.fail` + `Sfn.catchTag` (typed failure, recovered).
 */
import { Sfn } from "@/AWS/StepFunctions";
import * as Data from "effect/Data";

export class OrderRejected extends Data.TaggedError("OrderRejected")<{
  readonly reason: string;
}> {}

export interface OrderInput {
  value: number;
  items: number[];
}

export interface OrderOutput {
  doubled: number;
  items: number[];
  size: "big" | "small";
  recovered: string;
}

export const makeOrderProgram = (doubler: Sfn.InvokableFunction) =>
  Sfn.gen(function* (input: Sfn.Expr<OrderInput>) {
    // Lambda Task with a bounded retry (cold starts, transient faults)
    const doubled = yield* Sfn.invoke<{ doubled: number }>(doubler, {
      value: input.value,
    }).pipe(Sfn.retry({ maxAttempts: 2, initial: "1 second" }));

    // inline Map: double every item through the same function
    const items = yield* Sfn.forEach(
      input.items,
      (item) =>
        Sfn.gen(function* () {
          const result = yield* Sfn.invoke<{ doubled: number }>(doubler, {
            value: item,
          });
          return result.doubled;
        }),
      { concurrency: 1 },
    );

    // Choice on the task result
    const size = yield* Sfn.when(
      Sfn.gt(doubled.doubled, 10),
      Sfn.succeed("big"),
      Sfn.succeed("small"),
    );

    // typed failure recovered with catchTag (narrows E back to never)
    const recovered = yield* Sfn.fail(
      new OrderRejected({ reason: "no stock" }),
      "no stock",
    ).pipe(Sfn.catchTag("OrderRejected", (error) => Sfn.succeed(error.Cause)));

    return {
      doubled: doubled.doubled,
      items,
      size,
      recovered,
    };
  });
