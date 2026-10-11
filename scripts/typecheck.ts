// @effect-diagnostics nodeBuiltinImport:off - This compiler launcher runs before the application runtime.
import {
  HostProcessArchitecture,
  HostProcessArguments,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

function runCompiler(compilerUrl: URL, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodeURL.fileURLToPath(compilerUrl), ...args],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Typecheck terminated by ${result.signal}`);
  return result.status ?? 1;
}

const platform = Effect.runSync(HostProcessPlatform);
const architecture = Effect.runSync(HostProcessArchitecture);
const extraArgs = Effect.runSync(HostProcessArguments).slice(2);
const supportsRust =
  (platform === "darwin" && architecture === "arm64") ||
  (platform === "linux" && (architecture === "x64" || architecture === "arm64"));

if (supportsRust && extraArgs.length === 0) {
  process.exitCode = runCompiler(
    new URL("./bin/tsc-rs", import.meta.resolve("tsc-rs/package.json")),
    ["--noEmit"],
  );
} else {
  process.stderr.write(
    supportsRust
      ? "Custom compiler arguments use Effect-patched TypeScript.\n"
      : `tsc-rs has no ${platform}-${architecture} binary; using Effect-patched TypeScript.\n`,
  );
  process.exitCode = runCompiler(
    new URL("./bin/tsc", import.meta.resolve("typescript/package.json")),
    ["--noEmit", ...extraArgs],
  );
}
