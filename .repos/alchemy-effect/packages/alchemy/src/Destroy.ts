import type { ConfigError } from "effect/Config";
import { Effect } from "effect";
import type * as Scope from "effect/Scope";
import type { AlchemyContext } from "./AlchemyContext.ts";
import * as Apply from "./Apply.ts";
import * as Plan from "./Plan.ts";
import type { CompiledStack, StackEffect } from "./Stack.ts";
import { evalStack } from "./Stack.ts";
import type { Stage } from "./Stage.ts";

export const destroy = ({
  stack,
  stage,
  dev,
  scope,
  include,
  exclude,
}: {
  stack: StackEffect<CompiledStack, ConfigError, Stage | AlchemyContext>;
  stage: string;
  dev?: boolean;
  /** See {@link evalStack} — when set, scoped resources outlive `destroy`. */
  scope?: Scope.Scope;
  /** Destroy always operates on the full stack. */
  include?: never;
  exclude?: never;
}) =>
  include !== undefined || exclude !== undefined
    ? Effect.die(
        new Plan.InvalidResourceSelection({
          message: "Filtered destroy is not supported.",
        }),
      )
    : evalStack(
        stack,
        (stack) => Plan.destroy(stack).pipe(Effect.flatMap(Apply.apply)),
        { stage, dev, scope },
      );
