import { Effect } from "effect";

import { resolveInteraction } from "./interactionResolver.ts";
import type { ReplayFixture } from "./types.ts";

export interface ReplayCliInvocation<Input, Result, ErrorType> {
  readonly service: string;
  readonly operation: string;
  readonly input: Input;
  readonly mapResult: (result: unknown) => Result;
  readonly mapError: (cause: unknown) => ErrorType;
}

export function createReplayCliInvoker(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
): <Input, Result, ErrorType>(
  invocation: ReplayCliInvocation<Input, Result, ErrorType>,
) => Effect.Effect<Result, ErrorType> {
  return (invocation) =>
    Effect.try({
      try: () => {
        const replayResult = resolveInteraction<unknown>(
          fixture,
          `${invocation.service}.${invocation.operation}`,
          invocation.input,
          state,
        ).result;
        return invocation.mapResult(replayResult);
      },
      catch: invocation.mapError,
    });
}
