import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import {
  MACOS_MANAGED_PREFERENCES_PATH,
  managedPolicyPath,
  readManagedPolicy,
  WINDOWS_POLICY_KEY,
} from "./managedPolicyFile.ts";

const policy = JSON.stringify({ schemaVersion: 1, organization: "Example Corp" });

/** What a command prints and exits with; `exitCode: "hang"` never exits. */
type Result = { readonly stdout: string; readonly exitCode: number | "hang" };

/** Files that exist, and what a command prints and exits with, by command name and arguments. */
const machine = (
  files: Readonly<Record<string, string>>,
  commands: Readonly<Record<string, Result | ((args: ReadonlyArray<string>) => Result)>>,
) =>
  Layer.mergeAll(
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(path in files),
      readFileString: (path) => Effect.succeed(files[path] ?? ""),
    }),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const { command: name, args } = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        const answer = commands[name] ?? { stdout: "", exitCode: 127 };
        const result = typeof answer === "function" ? answer(args) : answer;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode:
              result.exitCode === "hang"
                ? Effect.never
                : Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(result.stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
  );

const read = (
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string>>,
  commands: Parameters<typeof machine>[1] = {},
) =>
  readManagedPolicy(platform).pipe(
    Effect.map((found) => found?.source),
    Effect.catchTags({
      ManagedPolicyFileError: (error) => Effect.succeed(`error: ${error.reason}`),
    }),
    Effect.provide(machine(files, commands)),
  );

describe("readManagedPolicy", () => {
  it.effect("reads a macOS configuration profile, and refuses one beside a policy file", () =>
    Effect.gen(function* () {
      const plutil = { "/usr/bin/plutil": { stdout: policy, exitCode: 0 } };
      const profile = { [MACOS_MANAGED_PREFERENCES_PATH]: "<binary plist>" };
      const file = { [managedPolicyPath("darwin")]: policy };

      assert.equal(yield* read("darwin", profile, plutil), MACOS_MANAGED_PREFERENCES_PATH);
      const plist = (contents: object) => ({
        "/usr/bin/plutil": { stdout: JSON.stringify(contents), exitCode: 0 },
      });
      const settings = JSON.parse(policy);
      // What macOS 27 writes for a manually installed profile.
      assert.equal(
        yield* read(
          "darwin",
          profile,
          plist({ ...settings, PayloadUUID: "e8c7f49b", _manualProfile: true }),
        ),
        MACOS_MANAGED_PREFERENCES_PATH,
      );
      assert.equal(
        yield* read("darwin", profile, plist({ Forced: [{ mcx_preference_settings: settings }] })),
        MACOS_MANAGED_PREFERENCES_PATH,
      );
      // Keys beside the wrapper, or a second entry, are refused rather than dropped or merged.
      for (const ambiguous of [
        { Forced: [{ mcx_preference_settings: settings }], limits: { telemetry: false } },
        { Forced: [{ mcx_preference_settings: settings }, { mcx_preference_settings: settings }] },
      ]) {
        assert.include(
          yield* read("darwin", profile, plist(ambiguous)),
          "does not match the policy schema",
        );
      }
      assert.equal(yield* read("darwin", file), managedPolicyPath("darwin"));
      const typo = JSON.stringify({ ...settings, limits: { maxRuntimeMod: "auto" } });
      assert.include(
        yield* read("darwin", { [managedPolicyPath("darwin")]: typo }),
        '["limits"]["maxRuntimeMod"]',
      );
      assert.isUndefined(yield* read("darwin", {}));
      assert.include(
        yield* read("darwin", { ...profile, ...file }, plutil),
        "deploy the policy one way",
      );
      // A profile plutil cannot convert fails closed rather than reading as no policy.
      assert.include(
        yield* read("darwin", profile, { "/usr/bin/plutil": { stdout: "", exitCode: 1 } }),
        "cannot be read",
      );
    }),
  );

  it.effect("reads the Windows Policies registry value, and treats a missing one as none", () =>
    Effect.gen(function* () {
      // The Policies root answers unless the registry itself cannot be read.
      const reg = (
        stdout: string,
        exitCode: number | "hang" = 0,
        rootExitCode: number | "hang" = 0,
      ) => ({
        "C:\\Windows\\System32\\reg.exe": (args: ReadonlyArray<string>) =>
          args.includes("/v") ? { stdout, exitCode } : { stdout: "", exitCode: rootExitCode },
      });
      const output = (type: string, value: string) =>
        `\r\n${WINDOWS_POLICY_KEY}\r\n    Policy    ${type}    ${value}\r\n\r\n`;

      assert.equal(yield* read("win32", {}, reg(output("REG_SZ", policy))), WINDOWS_POLICY_KEY);
      assert.isUndefined(yield* read("win32", {}, reg("", 1)));
      // Where reg cannot read the registry at all, the file still applies.
      assert.isUndefined(yield* read("win32", {}, reg("", 1, 1)));
      assert.equal(
        yield* read("win32", { [managedPolicyPath("win32")]: policy }, reg("", 1, 1)),
        managedPolicyPath("win32"),
      );
      // Once reg works, a failed query of the value is not read as no policy.
      assert.include(yield* read("win32", {}, reg("", 5)), "cannot be read as a string");
      assert.equal(
        yield* read("win32", { [managedPolicyPath("win32")]: policy }, reg("", 1)),
        managedPolicyPath("win32"),
      );
      assert.include(yield* read("win32", {}, reg(output("REG_DWORD", "0x1"))), "as a string");
      assert.include(
        yield* read("win32", {}, reg(output("REG_SZ", "{ not json"))),
        "does not match the policy schema",
      );
      // A hung query times out: the root as unreadable, the value as a failure.
      const timedOut = (stdout: string, exitCode: number | "hang", rootExitCode: number | "hang") =>
        Effect.gen(function* () {
          const fiber = yield* read("win32", {}, reg(stdout, exitCode, rootExitCode)).pipe(
            Effect.forkChild,
          );
          yield* TestClock.adjust("10 seconds");
          return yield* Fiber.join(fiber);
        });
      assert.isUndefined(yield* timedOut("", 1, "hang"));
      assert.include(yield* timedOut("", "hang", 0), "registry cannot be read");
    }),
  );
});
