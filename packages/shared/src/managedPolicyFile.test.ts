import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "./HostProcess.ts";

import {
  MACOS_MANAGED_PREFERENCES_PATH,
  managedPolicyPath,
  readManagedPolicy,
  WINDOWS_POLICY_KEY,
  layerWindowsRegistry,
  WindowsRegistry,
  WindowsRegistryError,
} from "./managedPolicyFile.ts";

const policy = JSON.stringify({ schemaVersion: 1, organization: "Example Corp" });

/** What a command prints and exits with. */
type Result = { readonly stdout: string; readonly exitCode: number };

/** The registry's `Policy` value: its text, absent, or the Win32 error reading it fails with. */
type RegistryAnswer = string | undefined | { readonly code?: number };

/** Files that exist, what a command prints and exits with by command name, and the registry. */
const machine = (
  files: Readonly<Record<string, string>>,
  commands: Readonly<Record<string, Result>>,
  registry: RegistryAnswer,
) =>
  Layer.mergeAll(
    Layer.succeed(
      WindowsRegistry,
      WindowsRegistry.of({
        readMachineString: () =>
          typeof registry === "object"
            ? Effect.fail(new WindowsRegistryError(registry))
            : Effect.succeed(registry),
      }),
    ),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(path in files),
      readFileString: (path) => Effect.succeed(files[path] ?? ""),
    }),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const { command: name } = command as unknown as { readonly command: string };
        const result = commands[name] ?? { stdout: "", exitCode: 127 };
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
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
  registry: RegistryAnswer = undefined,
) =>
  readManagedPolicy(platform).pipe(
    Effect.map((found) => found?.source),
    Effect.catchTags({
      ManagedPolicyFileError: (error) => Effect.succeed(`error: ${error.reason}`),
    }),
    Effect.provide(machine(files, commands, registry)),
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

  it.effect(
    "reads the Windows Policies registry value, and treats only an absent one as none",
    () =>
      Effect.gen(function* () {
        const file = { [managedPolicyPath("win32")]: policy };
        const win32 = (files: Readonly<Record<string, string>>, registry: RegistryAnswer) =>
          read("win32", files, {}, registry);

        assert.equal(yield* win32({}, policy), WINDOWS_POLICY_KEY);
        assert.isUndefined(yield* win32({}, undefined));
        assert.equal(yield* win32(file, undefined), managedPolicyPath("win32"));
        assert.include(yield* win32(file, policy), "deploy the policy one way");
        // A read that fails, here access denied, is not read as no policy, file or not.
        for (const files of [{}, file]) {
          assert.include(
            yield* win32(files, { code: 5 }),
            "the registry cannot be read (Windows error 5)",
          );
        }
        assert.include(yield* win32({}, {}), "cannot load its registry reader; reinstall T3 Code");
        assert.include(
          yield* win32({}, { code: 1630 }),
          "its Policy value is not a string (REG_SZ)",
        );
        assert.include(yield* win32({}, "{ not json"), "does not match the policy schema");
      }),
  );

  it.effect.runIf(HostProcess.Platform.defaultValue() === "win32")(
    "reads REG_SZ values through the Win32 API, and refuses other types",
    () =>
      Effect.gen(function* () {
        const registry = yield* WindowsRegistry;
        const version = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
        assert.match((yield* registry.readMachineString(version, "ProductName")) ?? "", /Windows/);
        assert.isUndefined(yield* registry.readMachineString(version, "T3CodeNoSuchValue"));
        assert.isUndefined(
          yield* registry.readMachineString("SOFTWARE\\T3CodeNoSuchKey", "Policy"),
        );
        // REG_DWORD, and REG_EXPAND_SZ, which would otherwise expand the user's variables.
        for (const [key, value] of [
          [version, "CurrentMajorVersionNumber"],
          ["SOFTWARE\\Microsoft\\Windows\\CurrentVersion", "ProgramFilesPath"],
        ] as const) {
          const error = yield* registry.readMachineString(key, value).pipe(Effect.flip);
          assert.equal(error.code, 1630);
        }
      }).pipe(Effect.provide(layerWindowsRegistry(() => import("ffi-rs")))),
  );
});
