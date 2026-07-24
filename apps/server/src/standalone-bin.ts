import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { cli } from "./cli/root.ts";
import { formatRemoteCliDiagnostic } from "./cli/remote.ts";

const CliRuntimeLayer = Layer.mergeAll(BunServices.layer, NetService.layer);

export const reportRemoteCliFailure = (
  error: unknown,
  setExitCode: (exitCode: number) => void = (exitCode) => {
    process.exitCode = exitCode;
  },
) => {
  const exitCode = Runtime.getErrorExitCode(error);
  const shouldReport = Runtime.getErrorReported(error);
  return (shouldReport ? Console.error(formatRemoteCliDiagnostic(error)) : Effect.void).pipe(
    Effect.andThen(Effect.sync(() => setExitCode(exitCode))),
  );
};

if (import.meta.main) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    Effect.catch((error) =>
      process.argv.slice(2).includes("remote") ? reportRemoteCliFailure(error) : Effect.fail(error),
    ),
    BunRuntime.runMain,
  );
}
