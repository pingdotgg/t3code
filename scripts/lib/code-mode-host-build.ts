import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

class CodeModeHostBuildError extends Schema.TaggedError<CodeModeHostBuildError>()(
  "CodeModeHostBuildError",
  {
    detail: Schema.String,
  },
) {}

/** Build-time only: installed environments spawn the staged binary and never need Cargo. */
export const buildCodeModeHost = Effect.fn("buildCodeModeHost")(function* (input: {
  repoRoot: string;
  targetKey?: string;
  verbose?: boolean;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const targetKey = input.targetKey ?? `${hostPlatform}-${hostArchitecture}`;
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win-arm64": "aarch64-pc-windows-msvc",
    "win-x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[targetKey];
  if (!target)
    return yield* new CodeModeHostBuildError({
      detail: `Unsupported code host target ${targetKey}`,
    });
  const crate = path.join(input.repoRoot, "native/code-mode-host");
  const name = targetKey.startsWith("win") ? "t3-code-mode-host.exe" : "t3-code-mode-host";
  const binary = path.join(crate, "target", target, "release", name);
  const reuse = yield* Config.boolean("T3CODE_DESKTOP_REUSE_CODE_MODE_HOST").pipe(
    Config.withDefault(false),
  );
  if (reuse) {
    if (!(yield* fs.exists(binary)))
      return yield* new CodeModeHostBuildError({
        detail: `Cached code mode host is missing: ${binary}`,
      });
  } else {
    const command = yield* resolveSpawnCommand("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      path.join(crate, "Cargo.toml"),
      "--target",
      target,
    ]);
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        cwd: input.repoRoot,
        shell: command.shell,
        stdout: input.verbose ? "inherit" : "ignore",
        stderr: "inherit",
      }),
    );
    const exitCode = yield* child.exitCode;
    if (exitCode !== 0)
      return yield* new CodeModeHostBuildError({ detail: `Cargo exited with ${exitCode}` });
  }
  const directory = path.join(
    input.repoRoot,
    "apps/server/dist/code-mode-host",
    targetKey.replace(/^win-/, "win32-"),
  );
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.copyFile(binary, path.join(directory, name));
  if (!targetKey.startsWith("win")) yield* fs.chmod(path.join(directory, name), 0o755);
});
