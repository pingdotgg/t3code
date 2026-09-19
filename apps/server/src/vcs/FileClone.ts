import { GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { windowsFileCloneScript } from "./WindowsFileClone.ts";

const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      sources: Schema.Array(Schema.String),
      destination: Schema.String,
    }),
  ),
);

/** Forced copy-on-write: unsupported volumes fail without a whole-file copy or hardlink. */
export const makeFileClone = Effect.fn("makeFileClone")(function* () {
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const supported = platform === "darwin" || platform === "win32";
  const clone = Effect.fn("FileClone.copy")(function* (
    sources: ReadonlyArray<string>,
    destination: string,
  ) {
    if (!supported) {
      return yield* new GitCommandError({
        operation: "FileClone.copy",
        command: "clone",
        cwd: destination,
        detail: "Filesystem cloning is unavailable on this platform",
      });
    }
    const command =
      platform === "win32"
        ? ChildProcess.make(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(windowsFileCloneScript, "utf16le").toString("base64"),
            ],
            {
              stdin: Stream.succeed(Buffer.from(encodeRequest({ sources, destination }), "utf8")),
              stdout: "ignore",
              stderr: "ignore",
            },
          )
        : ChildProcess.make("/bin/cp", ["-c", "-p", "-R", "-P", ...sources, destination], {
            stdout: "ignore",
            stderr: "ignore",
          });
    const code = yield* spawner.exitCode(command).pipe(Effect.timeout(300_000));
    if (code !== 0) {
      return yield* new GitCommandError({
        operation: "FileClone.copy",
        command: platform === "win32" ? "powershell.exe" : "/bin/cp",
        cwd: destination,
        detail: "Filesystem clone unavailable",
        exitCode: code,
      });
    }
  });
  return { supported, clone };
});
