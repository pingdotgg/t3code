import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { browserCommand } from "./browser.ts";

const BROWSER = "/t3/tools/chrome-headless-shell/linux64/154/chrome-headless-shell";
const FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";

/**
 * Records every command. `fc-match` is missing until fonts are installed, unless
 * the host starts with a font; the browser fails to load libnss3 when asked to.
 */
const fakeSpawner = (host: { readonly font?: string; readonly missingLibrary?: boolean }) => {
  const commands: Array<ReadonlyArray<string>> = [];
  let font = host.font;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      commands.push([command.command, ...command.args]);
      if (command.command === "apt-get" && command.args.includes("fonts-liberation")) font = FONT;
      if (command.command === "fc-match" && font === undefined) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
        });
      }
      const output =
        command.command === "fc-match"
          ? font!
          : command.command === BROWSER && host.missingLibrary
            ? "error while loading shared libraries: libnss3.so: cannot open shared object file"
            : command.command === "ldd"
              ? "\tlibnss3.so => not found\n"
              : "";
      const bytes = Stream.make(new TextEncoder().encode(output));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: bytes,
        stderr: Stream.empty,
        all: bytes,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, commands };
};

/** A Linux host with apt and T3's browser installed under `/t3`. */
const runSetup = (host: {
  readonly root: boolean;
  readonly font?: string;
  readonly missingLibrary?: boolean;
}) => {
  const { spawner, commands } = fakeSpawner(host);
  const fs = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(path === "/usr/bin/apt-get" || path === BROWSER),
    readDirectory: (path) =>
      Effect.succeed(path.endsWith("chrome-headless-shell") ? ["linux64"] : ["154"]),
  });
  return Effect.gen(function* () {
    yield* Command.runWith(browserCommand, { version: "0.0.0" })(["setup", "--base-dir", "/t3"]);
    return { commands, output: (yield* TestConsole.logLines).join("\n") };
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.UserId, host.root ? 0 : 1000),
    // Root through sudo from a regular user, so setup reports ready instead of the root warning.
    Effect.provideService(HostProcess.Environment, host.root ? { SUDO_USER: "alice" } : {}),
    Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)),
  );
};

const aptGet = (commands: ReadonlyArray<ReadonlyArray<string>>) =>
  commands.filter(([name]) => name === "apt-get");

it.effect("setup in a root shell warns that the server cannot run as root", () =>
  Effect.gen(function* () {
    // Every file read fails, so setup finds nothing to install and changes nothing.
    yield* Command.runWith(browserCommand, { version: "0.0.0" })([
      "setup",
      "--base-dir",
      "/nonexistent",
    ]).pipe(
      Effect.provide(FileSystem.layerNoop({})),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        fakeSpawner({ font: FONT }).spawner,
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 0),
      // A root user who follows the old advice runs setup through sudo.
      Effect.provideService(HostProcess.Environment, { SUDO_USER: "root" }),
    );
    const output = (yield* TestConsole.logLines).join("\n");
    expect(output).toContain("Chrome will not start its sandbox as root");
    expect(output).not.toContain("ready");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);

it.effect("setup without root does not report a host without fonts as ready", () =>
  Effect.gen(function* () {
    const { commands, output } = yield* runSetup({ root: false });
    expect(output).toContain(
      "T3's browser needs fontconfig and system fonts; setup installs them.",
    );
    expect(output).toContain("This needs root. Run:");
    expect(output).not.toContain("ready");
    expect(aptGet(commands)).toEqual([]);
  }),
);

it.effect("setup as root installs missing libraries and fonts after one package refresh", () =>
  Effect.gen(function* () {
    const { commands, output } = yield* runSetup({ root: true, missingLibrary: true });
    const apt = aptGet(commands);
    expect(apt.filter(([, action]) => action === "update")).toHaveLength(1);
    expect(apt.find((args) => args.includes("libnss3"))).toBeDefined();
    expect(apt).toContainEqual([
      "apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      "fontconfig",
      "fonts-liberation",
    ]);
    expect(output).toContain("Installed the browser's fonts.");
    expect(output).toContain("This host is ready for T3's browser.");
  }),
);
