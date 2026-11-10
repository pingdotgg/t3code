import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * A program that cannot be evaluated, standing in for a declaration that
 * calls a cloud API while it is declared (#1976). Only a destroy, which plans
 * from state alone, can run this stack.
 */
export default Alchemy.Stack(
  "CliDestroySkipsProgram",
  { providers: Layer.empty, state: Alchemy.localState() },
  Effect.die(new Error("STACK_PROGRAM_EVALUATED")),
);
