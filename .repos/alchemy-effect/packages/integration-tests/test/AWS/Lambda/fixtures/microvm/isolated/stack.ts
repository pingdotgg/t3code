import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import IsolatedOrchestrator from "./orchestrator.ts";
import IsolatedSandboxLive from "./sandbox.ts";

/**
 * Isolated-project MicroVM stack: the bundled {@link IsolatedSandboxLive}
 * image plus the Lambda orchestrator that drives one MicroVM through its
 * in-VM RPC + fetch routes.
 */
export default Alchemy.Stack(
  "IsolatedProjectMicrovmStack",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const fn = yield* IsolatedOrchestrator;
    return {
      url: fn.functionUrl.as<string>(),
    };
  }).pipe(Effect.provide(IsolatedSandboxLive)),
);
