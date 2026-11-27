import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as ServerConfig from "../config.ts";

const quoteShell = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * Writes the script integrated terminals get as BROWSER: it runs `t3 browser open` against this
 * server. None on Windows, where a `.cmd` script re-parses the `&` in the URLs it passes on, or
 * when the path has whitespace, since tools split BROWSER on it.
 */
export const writeTerminalBrowserCommand = Effect.fn("terminal.writeBrowserCommand")(function* (
  config: Pick<ServerConfig.ServerConfig["Service"], "baseDir" | "stateDir" | "devUrl">,
) {
  if ((yield* HostProcess.Platform) === "win32") return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scriptPath = path.join(config.stateDir, "bin", "t3-browser");
  if (/\s/.test(scriptPath)) return undefined;
  // `--base-dir` always resolves to userdata, so a dev server's state is found by its dev URL.
  const location =
    config.stateDir === path.join(config.baseDir, "userdata")
      ? ["--base-dir", config.baseDir]
      : config.devUrl === undefined
        ? []
        : ["--dev-url", config.devUrl.href];
  const invocation = yield* resolveSelfInvocation();
  const command = [
    invocation.command,
    ...selfInvocationArgs(invocation, ["browser", "open", ...location]),
  ]
    .map(quoteShell)
    .join(" ");
  yield* fs.makeDirectory(path.dirname(scriptPath), { recursive: true });
  yield* fs.writeFileString(scriptPath, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${command} "$@"\n`);
  yield* fs.chmod(scriptPath, 0o755);
  return scriptPath;
});
