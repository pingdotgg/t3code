import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { AlchemyContext } from "./AlchemyContext.ts";
import * as Apply from "./Apply.ts";
import type { Input } from "./Input.ts";
import * as Plan from "./Plan.ts";
import { evalStack, type CompiledStack, type StackEffect } from "./Stack.ts";
import { Stage } from "./Stage.ts";

export const deploy = <A>({
  stack,
  stage,
  dev,
  scope,
  force,
}: {
  stack: StackEffect<CompiledStack<A>, Stage | AlchemyContext>;
  stage: string;
  dev?: boolean;
  /** See {@link evalStack} — when set, scoped resources outlive `deploy`. */
  scope?: Scope.Scope;
  force?: boolean;
}) =>
  evalStack(
    stack,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make(stack, { force });
        const output = yield* Apply.apply(plan);
        return output as Input.Resolve<A>;
      }),
    { stage, dev, scope },
  );
