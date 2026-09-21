import { GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { windowsFileCloneScript } from "./WindowsFileClone.ts";

const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        sources: Schema.Array(Schema.String),
        destination: Schema.String,
      }),
    ),
  ),
);

/** Forced copy-on-write: unsupported volumes fail without a whole-file copy or hardlink. */
export const makeFileClone = Effect.fn("makeFileClone")(function* () {
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const supported = platform === "darwin" || platform === "win32";
  const run = Effect.fn("FileClone.run")(function* (
    command: ChildProcess.Command,
    destination: string,
  ) {
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
  const cloneGroups = Effect.fn("FileClone.copyGroups")(function* (
    groups: ReadonlyArray<{ sources: ReadonlyArray<string>; destination: string }>,
  ) {
    if (groups.length === 0) return;
    yield* run(
      ChildProcess.make(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsFileCloneScript, "utf16le").toString("base64"),
        ],
        {
          stdin: Stream.succeed(Buffer.from(encodeRequest(groups), "utf8")),
          stdout: "ignore",
          stderr: "ignore",
        },
      ),
      groups[0]!.destination,
    );
  });
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
    if (platform === "win32") return yield* cloneGroups([{ sources, destination }]);
    if (platform === "darwin") {
      // APFS clones inherit immutable flags. Reject these sources before copying
      // so Git fallback and cancellation can still remove every created file.
      const immutable = yield* spawner
        .string(
          ChildProcess.make(
            "/usr/bin/find",
            ["-P", ...sources, "-flags", "+uchg,schg", "-print", "-quit"],
            { stderr: "ignore" },
          ),
        )
        .pipe(Effect.timeout(300_000));
      if (immutable.length > 0) {
        return yield* new GitCommandError({
          operation: "FileClone.copy",
          command: "/bin/cp",
          cwd: destination,
          detail: "Immutable source files require ordinary checkout",
        });
      }
    }
    yield* run(
      ChildProcess.make("/bin/cp", ["-c", "-p", "-R", "-P", ...sources, destination], {
        stdout: "ignore",
        stderr: "ignore",
      }),
      destination,
    );
  });
  return { supported, clone, cloneGroups: platform === "win32" ? cloneGroups : undefined };
});
