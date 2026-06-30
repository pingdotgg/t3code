import type { StepOutcome } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";

export interface StubScript {
  readonly default: StepOutcome;
  readonly byStepKey?: Record<string, StepOutcome>;
}

export const makeStubStepExecutor = (script: StubScript): Layer.Layer<StepExecutor> =>
  Layer.succeed(StepExecutor, {
    execute: (ctx) => Effect.succeed(script.byStepKey?.[ctx.step.key as string] ?? script.default),
  } satisfies StepExecutorShape);
