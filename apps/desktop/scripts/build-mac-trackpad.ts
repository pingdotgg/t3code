#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";

const TARGETS = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] } as const;
type TrackpadArch = keyof typeof TARGETS;
const isTrackpadArch = (arch: string): arch is TrackpadArch => Object.hasOwn(TARGETS, arch);

export class MacTrackpadBuildError extends Schema.TaggedError<MacTrackpadBuildError>()(
  "MacTrackpadBuildError",
  { message: Schema.String },
) {}

const modifiedAt = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((info) => Option.getOrElse(Option.map(info.mtime, Number), () => 0)),
    Effect.orElseSucceed(() => 0),
  );

/** Packaging passes `output` and must not ship without the monitor; dev builds only lose it. */
export const buildMacTrackpad = Effect.fn("buildMacTrackpad")(function* (input: {
  readonly arch: Option.Option<TrackpadArch>;
  readonly output: Option.Option<string>;
}) {
  if ((yield* HostProcess.Platform) !== "darwin") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const hostArch = yield* HostProcess.Architecture;
  const arch = Option.getOrUndefined(input.arch) ?? (isTrackpadArch(hostArch) ? hostArch : null);
  if (arch === null) {
    return yield* new MacTrackpadBuildError({
      message: `Unsupported macOS architecture: ${hostArch}`,
    });
  }
  const root = yield* path.fromFileUrl(new URL("../../../native/mac-trackpad/", import.meta.url));
  const source = path.join(root, "TrackpadScroll.m");
  const output = Option.getOrElse(input.output, () =>
    path.join(root, "build", arch, "libt3-trackpad.dylib"),
  );
  const inputsModifiedAt = Math.max(
    yield* modifiedAt(fs, source),
    yield* modifiedAt(fs, yield* path.fromFileUrl(new URL(import.meta.url))),
  );
  if ((yield* modifiedAt(fs, output)) >= inputsModifiedAt) return;

  yield* fs.makeDirectory(path.dirname(output), { recursive: true });
  const compile = Effect.gen(function* () {
    const scratch = yield* fs.makeTempDirectoryScoped({
      directory: path.dirname(output),
      prefix: ".trackpad-",
    });
    const temporary = path.join(scratch, "libt3-trackpad.dylib");
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "xcrun",
        [
          "clang",
          "-dynamiclib",
          "-fobjc-arc",
          "-O2",
          "-mmacosx-version-min=12.0",
          ...TARGETS[arch].flatMap((target) => ["-arch", target]),
          "-framework",
          "AppKit",
          source,
          "-o",
          temporary,
        ],
        { stdout: "inherit", stderr: "inherit" },
      ),
    );
    const exitCode = Number(yield* child.exitCode);
    if (exitCode !== 0) {
      return yield* new MacTrackpadBuildError({ message: `clang exited with code ${exitCode}.` });
    }
    yield* fs.rename(temporary, output);
  }).pipe(Effect.scoped);

  if (Option.isSome(input.output)) return yield* compile;
  yield* compile.pipe(
    Effect.catch(() =>
      Effect.logWarning(
        "Skipping the macOS trackpad monitor. Install Xcode Command Line Tools to build it.",
      ),
    ),
  );
});

const command = Command.make(
  "build-mac-trackpad",
  {
    arch: Flag.Literals("arch", ["arm64", "x64", "universal"] as const).pipe(Flag.optional),
    output: Flag.String("output").pipe(Flag.optional),
  },
  buildMacTrackpad,
).pipe(Command.withDescription("Build the macOS trackpad scroll-phase monitor dylib."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
