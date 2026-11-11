import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * External MicroVM stack: builds a user-provided Dockerfile + context
 * server-side (no Effect bundling). The build role is created bare — the
 * MicroVM image grants it the trust + build permissions via a binding.
 */
export default Alchemy.Stack(
  "MicrovmExternalStack",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const buildRole = yield* AWS.IAM.Role("ExternalMicrovmBuildRole", {});
    const image = yield* AWS.Lambda.MicrovmImage("ExternalSandbox", {
      context: fileURLToPath(
        new URL("../../../../Lambda/fixtures/microvm/external", import.meta.url),
      ),
      buildRole,
    });
    return {
      imageArn: image.imageArn.as<string>(),
      state: image.state.as<string>(),
    };
  }),
);
