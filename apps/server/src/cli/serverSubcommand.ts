// @effect-diagnostics nodeBuiltinImport:off -- resolves the source or bundled server entry at the process boundary.
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

/** Describes a server subprocess; its caller owns starting and stopping it. */
export const serverSubcommand = Effect.fn("serverSubcommand")(function* (
  command: string,
  heapMb: number,
) {
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  // Bundling places this module in bin.mjs; source execution resolves from src/cli.
  const entry = NodeURL.fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
  );
  return {
    executable,
    args: [...(isExecutable ? [] : [entry]), command],
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""} --max-old-space-size=${heapMb}`,
    },
  };
});
