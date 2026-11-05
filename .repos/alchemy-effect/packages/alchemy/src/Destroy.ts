import { Effect } from "effect";
import * as Context from "effect/Context";
import type * as Scope from "effect/Scope";
import { applyAndRender } from "./Deploy.ts";
import { evalStack } from "./EvalStack.ts";
import * as Plan from "./Plan.ts";
import type { StackDefinition } from "./Stack.ts";
import { build, Stack } from "./Stack.ts";

export const destroy = <ROut>({
  stack,
  stage,
  dev,
  scope,
  include,
  exclude,
}: {
  /** The stack to tear down; its program is never run. */
  stack: StackDefinition<ROut>;
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
        new Plan.InvalidResourceSelection({ message: "Filtered destroy is not supported." }),
      )
    : evalStack(
        build({
          name: stack.stackName,
          providers: stack.providers,
          state: stack.state,
          secrets: stack.secrets,
        }).pipe(Effect.map((services) => ({ services }))),
        ({ services }) =>
          Plan.destroy(Context.get(services, Stack)).pipe(Effect.flatMap(applyAndRender)),
        { stage, dev, scope },
      );
