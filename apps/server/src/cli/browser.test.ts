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
import { ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import { browserCommand } from "./browser.ts";

const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const BROWSER_ROOT = "/home/me/.t3/tools/chrome-headless-shell";
const BROWSER = `${BROWSER_ROOT}/linux64/154/chrome-headless-shell`;

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

/** An Ubuntu host with the userns restriction on, the browser installed, and a system font. */
const runSetupAsRoot = (input: { readonly profile: string | undefined }) => {
  const files = new Map([
    [USERNS_RESTRICTION, "1\n"],
    [BROWSER, ""],
  ]);
  if (input.profile !== undefined) {
    files.set(PreviewBrowserHost.APPARMOR_PROFILE_PATH, input.profile);
  }
  const directories = new Map([
    [BROWSER_ROOT, ["linux64"]],
    [`${BROWSER_ROOT}/linux64`, ["154"]],
  ]);
  const commands: Array<string> = [];
  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => {
      const content = files.get(path);
      return content === undefined
        ? Effect.fail(notFound("readFileString", path))
        : Effect.succeed(content);
    },
    readDirectory: (path) => {
      const entries = directories.get(path);
      return entries === undefined
        ? Effect.fail(notFound("readDirectory", path))
        : Effect.succeed(entries);
    },
    writeFileString: (path, content) => Effect.sync(() => void files.set(path, content)),
  });
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { command: name, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push([name, ...args].join(" "));
      const output =
        name === "fc-match" ? "/usr/share/fonts/sans.ttf" : name === BROWSER ? "Chrome 154\n" : "";
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
  return Effect.gen(function* () {
    yield* Command.runWith(browserCommand, { version: packageJson.version })([
      "setup",
      "--base-dir",
      "/home/me/.t3",
    ]);
    return {
      output: (yield* TestConsole.logLines).join("\n"),
      profile: files.get(PreviewBrowserHost.APPARMOR_PROFILE_PATH),
      loads: commands.filter((command) => command.startsWith("apparmor_parser")),
    };
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.UserId, 0),
    Effect.provideService(HostProcess.Environment, { SUDO_USER: "me" }),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.fresh(TestConsole.layer))),
  );
};

const LOAD = `apparmor_parser -r ${PreviewBrowserHost.APPARMOR_PROFILE_PATH}`;

const CUSTOMIZED_PROFILE = PreviewBrowserHost.APPARMOR_PROFILE.replace(
  "  userns,\n",
  "  userns,\n  deny /tmp/t3-admin-private/** rw,\n",
);

it.effect.each([
  {
    label: "reloads a profile that is on disk",
    profile: PreviewBrowserHost.APPARMOR_PROFILE,
    written: PreviewBrowserHost.APPARMOR_PROFILE,
    said: "Reloaded the AppArmor profile",
  },
  {
    label: "writes and loads a missing profile",
    profile: undefined,
    written: PreviewBrowserHost.APPARMOR_PROFILE,
    said: "Wrote and loaded",
  },
  {
    label: "reloads a customized profile without rewriting it",
    profile: CUSTOMIZED_PROFILE,
    written: CUSTOMIZED_PROFILE,
    said: "Reloaded the AppArmor profile",
  },
])("t3 browser setup as root $label", (input) =>
  Effect.gen(function* () {
    const result = yield* runSetupAsRoot({ profile: input.profile });
    expect(result.loads).toEqual([LOAD]);
    expect(result.profile).toBe(input.written);
    expect(result.output).toContain(input.said);
    expect(result.output).toContain("This host is ready for T3's browser.");
  }),
);
