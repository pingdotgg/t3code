import { Sfn, StateMachine } from "@alchemy.run/aws/StepFunctions";
import * as Effect from "effect/Effect";
import { SaveDigest, Summarize } from "./Summarize.ts";

// #region show
export const Digest = Effect.gen(function* () {
  const summarize = yield* Summarize;
  const save = yield* SaveDigest;

  return yield* StateMachine.fromProgram("Digest", {
    program: Sfn.gen(function* (input: Sfn.Expr<{ room: string }>) {
      const summary = yield* Sfn.invoke<string>(summarize, { room: input.room });
      yield* Sfn.sleep("1 day");
      yield* Sfn.invoke(save, { room: input.room, summary });
    }),
  });
});
// #endregion show
