import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
export { cli, makeCli } from "./cli/root.ts";
import { cli } from "./cli/root.ts";
import { formatRemoteCliDiagnostic, isOrchestrationCliInvocation } from "./cli/remote.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

if (import.meta.main) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    Effect.catch((error) =>
      isOrchestrationCliInvocation(process.argv.slice(2))
        ? (Runtime.getErrorReported(error)
            ? Console.error(formatRemoteCliDiagnostic(error))
            : Effect.void
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = Runtime.getErrorExitCode(error);
              }),
            ),
          )
        : Effect.fail(error),
    ),
    NodeRuntime.runMain,
  );
}
