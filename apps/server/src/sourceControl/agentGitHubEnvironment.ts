import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Path from "effect/Path";

const quoteShell = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const quoteBatch = (value: string) => `"${value.replaceAll("%", "%%")}"`;

/**
 * Normal PATH-resolved gh calls in local provider processes share Claude's managed-read gate.
 * This is a request-saving launcher, not a sandbox: absolute binaries, replaced PATHs and remote
 * provider servers stay outside it. It never modifies the environment of T3's own GitHub clients.
 */
export const prepareAgentGitHubEnvironment = Effect.fn(
  "ProviderHost.prepareAgentGitHubEnvironment",
)(function* (input: {
  readonly stateDir: string;
  readonly invocation: SelfInvocation;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly enabled: boolean;
}) {
  const windows = input.platform === "win32";
  const delimiter = windows ? ";" : ":";
  const pathKey = windows
    ? (Object.keys(input.environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH")
    : "PATH";
  const inheritedPath = input.environment[pathKey];
  const previous = input.environment.T3_GH_SHIM_DIR;
  const searchPath =
    previous === undefined
      ? inheritedPath
      : inheritedPath
          ?.split(delimiter)
          .filter((entry) =>
            windows ? entry.toLowerCase() !== previous.toLowerCase() : entry !== previous,
          )
          .join(delimiter);
  const environment = { ...input.environment };
  if (searchPath !== undefined) environment[pathKey] = searchPath;
  delete environment.T3_GH_SHIM_DIR;
  if (!input.enabled) return environment;

  // Resolve before adding our launcher, and preserve the provider's own PATH overrides.
  const realCommand = yield* resolveCommandPath("gh", { env: environment });
  if (realCommand === null) return environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digestService = yield* Digest.Digest;
  const args = selfInvocationArgs(input.invocation, ["__github-cli", realCommand]);
  const source = windows
    ? `@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${[input.invocation.command, ...args].map(quoteBatch).join(" ")} %*\r\n`
    : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${[input.invocation.command, ...args].map(quoteShell).join(" ")} "$@"\n`;
  const digest = Hex.encode(
    yield* digestService.digest(Digest.sha256, new TextEncoder().encode(source)),
  );
  const directory = path.join(input.stateDir, "github", "bin", digest);
  const launcher = path.join(directory, windows ? "gh.cmd" : "gh");
  // Immutable launchers allow concurrent provider instances with different gh installations.
  if (!(yield* fs.exists(launcher))) {
    yield* fs.makeDirectory(directory, { recursive: true });
    const temporary = yield* fs.makeTempFile({ directory, prefix: "gh-" });
    yield* fs.writeFileString(temporary, source);
    if (!windows) yield* fs.chmod(temporary, 0o755);
    yield* fs.rename(temporary, launcher);
  }
  environment[pathKey] = `${directory}${searchPath === undefined ? "" : delimiter + searchPath}`;
  environment.T3_GH_SHIM_DIR = directory;
  return environment;
});
