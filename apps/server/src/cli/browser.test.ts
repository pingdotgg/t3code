import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
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

const runSetup = (input: {
  readonly font: string | undefined;
  readonly fontAfterInstall?: string;
  readonly root?: boolean;
  readonly apt?: boolean;
  readonly installedBrowser?: boolean;
  readonly missingLibraries?: boolean;
  readonly platform?: NodeJS.Platform;
}) => {
  const commands: Array<ReadonlyArray<string>> = [];
  let font = input.font;
  const browser = "/t3/tools/chrome-headless-shell/linux64/154/chrome-headless-shell";
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      commands.push([command.command, ...command.args]);
      if (command.command === "apt-get" && command.args.includes("fonts-liberation")) {
        font = input.fontAfterInstall ?? "/usr/share/fonts/liberation/LiberationSans-Regular.ttf";
      }
      if (command.command === "fc-match" && font === undefined) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
        });
      }
      const output =
        command.command === "fc-match"
          ? (font ?? "")
          : command.command === browser && input.missingLibraries
            ? "error while loading shared libraries: libnss3.so: cannot open shared object file"
            : command.command === "ldd"
              ? "libnss3.so => not found\n"
              : "Chrome 154\n";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(output)),
        stderr: Stream.empty,
        all: Stream.make(new TextEncoder().encode(output)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const fs = FileSystem.makeNoop({
    exists: (path) =>
      Effect.succeed(path === "/usr/bin/apt-get" ? (input.apt ?? true) : path === browser),
    readFileString: () => Effect.succeed("0"),
    readDirectory: (path) =>
      Effect.succeed(
        input.installedBrowser === false
          ? []
          : path.endsWith("chrome-headless-shell")
            ? ["linux64"]
            : ["154"],
      ),
  });
  return Effect.gen(function* () {
    yield* Command.runWith(browserCommand, { version: "0.0.0" })(["setup", "--base-dir", "/t3"]);
    return { commands, output: (yield* TestConsole.logLines).join("\n") };
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcessPlatform, input.platform ?? "linux"),
    Effect.provideService(HostProcessUserId, input.root ? 0 : 1000),
    Effect.provideService(HostProcessEnvironment, { PATH: "" }),
    Effect.provideService(HostProcessArguments, ["/usr/bin/node", "/t3/bin.mjs"]),
    Effect.provideService(HostProcessExecutablePath, "/usr/bin/node"),
    Effect.provideService(HostProcessIsExecutable, false),
    Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)),
  );
};

describe("t3 browser setup fonts", () => {
  it.effect.each([undefined, ""])(
    "reports missing fonts even when Chrome starts (fc-match: %s)",
    (font) =>
      Effect.gen(function* () {
        const { commands, output } = yield* runSetup({ font });
        expect(output).toContain("needs fontconfig and system fonts");
        expect(output).toContain("sudo t3 browser setup");
        expect(output).not.toContain("This host is ready");
        expect(commands.some(([name]) => name === "apt-get")).toBe(false);
      }),
  );

  it.effect("installs fonts before the browser's first use", () =>
    Effect.gen(function* () {
      const { commands, output } = yield* runSetup({
        font: undefined,
        root: true,
        installedBrowser: false,
      });
      expect(commands.filter(([name]) => name === "apt-get")).toEqual([
        ["apt-get", "update"],
        ["apt-get", "install", "-y", "--no-install-recommends", "fontconfig", "fonts-liberation"],
      ]);
      expect(output).toContain("Restart the T3 server");
      expect(output).toContain("This host is ready");
    }),
  );

  it.effect("leaves hosts with working fonts alone", () =>
    Effect.gen(function* () {
      const { commands, output } = yield* runSetup({
        font: "/usr/share/fonts/sans.ttf",
        root: true,
      });
      expect(commands.some(([name]) => name === "apt-get")).toBe(false);
      expect(output).toContain("This host is ready");
    }),
  );

  it.effect("does not report ready when fonts remain unavailable after installation", () =>
    Effect.gen(function* () {
      const { commands, output } = yield* runSetup({ font: "", fontAfterInstall: "", root: true });
      expect(commands.some(([name, action]) => name === "apt-get" && action === "install")).toBe(
        true,
      );
      expect(output).toContain("Check its configuration");
      expect(output).not.toContain("This host is ready");
    }),
  );

  it.effect("installs missing libraries and fonts with one package-list refresh", () =>
    Effect.gen(function* () {
      const { commands } = yield* runSetup({ font: "", root: true, missingLibraries: true });
      const packages = commands
        .filter(([name, action]) => name === "apt-get" && action === "install")
        .flatMap((command) => command.slice(2));
      expect(packages).toContain("libnss3");
      expect(packages).toContain("fonts-liberation");
      expect(
        commands.filter(([name, action]) => name === "apt-get" && action === "update"),
      ).toHaveLength(1);
    }),
  );

  it.effect("gives package-manager guidance without apt instead of reporting ready", () =>
    Effect.gen(function* () {
      const { commands, output } = yield* runSetup({ font: "", root: true, apt: false });
      expect(output).toContain("fontconfig and system fonts");
      expect(output).toContain("Install them with your package manager");
      expect(output).not.toContain("This host is ready");
      expect(commands.some(([name]) => name === "apt-get")).toBe(false);
    }),
  );

  it.effect("does not check fonts on macOS", () =>
    Effect.gen(function* () {
      const { commands, output } = yield* runSetup({ font: undefined, platform: "darwin" });
      expect(commands).toEqual([]);
      expect(output).toContain("Nothing to set up");
    }),
  );
});
