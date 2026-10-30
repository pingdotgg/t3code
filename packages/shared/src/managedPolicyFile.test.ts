import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  MACOS_MANAGED_PREFERENCES_PATH,
  managedPolicyPath,
  readManagedPolicy,
  WINDOWS_POLICY_KEY,
  windowsPolicyDocument,
} from "./managedPolicyFile.ts";

const policy = JSON.stringify({ schemaVersion: 1, organization: "Example Corp" });

type Result = { readonly stdout: string; readonly exitCode: number };

const TEMP = "C:\\Temp\\t3code-policy";
const EXPORT_FILE = `${TEMP}\\policy.reg`;
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const registryValue = (name: string, data: string | number, key = "") => ({
  key,
  name,
  type: typeof data === "number" ? ("REG_DWORD" as const) : ("REG_SZ" as const),
  data: typeof data === "number" ? `0x${data.toString(16)}` : data,
});

const registry = (values: Parameters<typeof windowsPolicyDocument>[0], exitCode = 0) => ({
  [POWERSHELL]: { stdout: JSON.stringify(values), exitCode },
});

/** Files that exist, and what a command prints and exits with, by command name and arguments. */
const machine = (
  files: Readonly<Record<string, string>>,
  commands: Readonly<Record<string, Result | ((args: ReadonlyArray<string>) => Result)>>,
) =>
  Layer.mergeAll(
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(path in files),
      readFileString: (path) => Effect.succeed(files[path] ?? ""),
      makeTempDirectoryScoped: () => Effect.succeed(TEMP),
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

  it.effect("reads Windows policy without trusting temporary files", () =>
    Effect.gen(function* () {
      const values = [registryValue("Organization", "Example Corp"), registryValue("Telemetry", 0)];
      const forgedExport = {
        [EXPORT_FILE]:
          "Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\T3Tools\\T3Code]\r\n",
      };
      const found = yield* readManagedPolicy("win32").pipe(
        Effect.provide(
          machine(forgedExport, {
            ...registry(values),
            "C:\\Windows\\System32\\reg.exe": { stdout: "", exitCode: 0 },
          }),
        ),
      );
      assert.deepStrictEqual(found, {
        source: WINDOWS_POLICY_KEY,
        document: { schemaVersion: 1, organization: "Example Corp", limits: { telemetry: false } },
      });
      for (const exitCode of [1, 5]) {
        assert.include(yield* read("win32", {}, registry([], exitCode)), "registry cannot be read");
      }
      for (const stdout of ["", "{", "{}", "null", '[{"key":""}]']) {
        assert.include(
          yield* read("win32", {}, { [POWERSHELL]: { stdout, exitCode: 0 } }),
          "registry reader returned invalid data",
        );
      }
      assert.include(
        yield* read("win32", { [managedPolicyPath("win32")]: policy }, registry(values)),
        "deploy the policy one way",
      );
      // Missing keys and disabled groups both leave no effective policy.
      for (const values of [
        [],
        [
          registryValue("AllowedDrivers", 0),
          registryValue("codex", 0, "AllowedDrivers"),
          registryValue("claudeAgent", 0, "AllowedDrivers"),
        ],
        [
          registryValue("Clients", 0),
          registryValue("desktop", 0, "Clients"),
          registryValue("remote", 0, "Clients"),
        ],
        [registryValue("Updates", 0), registryValue("AllowNightly", 0)],
      ]) {
        assert.isUndefined(yield* read("win32", {}, registry(values)));
        assert.equal(
          yield* read("win32", { [managedPolicyPath("win32")]: policy }, registry(values)),
          managedPolicyPath("win32"),
        );
      }
    }),
  );

  it.effect("builds the policy from the values the Group Policy template writes", () =>
    Effect.gen(function* () {
      const values = [
        registryValue("Organization", "Société 日本 ✓"),
        registryValue("SupportUrl", ""),
        registryValue("MaxRuntimeMode", "auto-accept-edits"),
        registryValue("Telemetry", 0),
        registryValue(
          "Settings",
          JSON.stringify({ gateway: { value: 'a\\b "日本"\n ', locked: true } }),
        ),
        registryValue("UpdatesMode", "off"),
        registryValue("AllowNightly", 1),
        registryValue("Updates", 1),
        registryValue("Clients", 1),
        registryValue("AllowedDrivers", 1),
        registryValue("desktop", 1, "Clients"),
        registryValue("remote", 0, "Clients"),
        registryValue("codex", 1, "AllowedDrivers"),
        registryValue("claudeAgent", 1, "AllowedDrivers"),
      ];
      const document = {
        schemaVersion: 1,
        organization: "Société 日本 ✓",
        settings: { gateway: { value: 'a\\b "日本"\n ', locked: true } },
        limits: {
          maxRuntimeMode: "auto-accept-edits",
          telemetry: false,
          updates: { mode: "off", allowNightly: true },
          clients: ["desktop"],
          providers: {
            allowedDrivers: [
              ProviderDriverKind.make("codex"),
              ProviderDriverKind.make("claudeAgent"),
            ],
          },
        },
      } as const;
      assert.deepStrictEqual(
        (yield* readManagedPolicy("win32").pipe(Effect.provide(machine({}, registry(values)))))
          ?.document,
        document,
      );
      assert.deepStrictEqual(
        windowsPolicyDocument(values.map((value) => ({ ...value, key: value.key.toLowerCase() }))),
        { document },
      );

      const organization = registryValue("Organization", "Example Corp");
      // Disabling a policy in Windows 11 leaves each checkbox's falseValue in the registry.
      assert.deepStrictEqual(
        windowsPolicyDocument([
          organization,
          registryValue("Clients", 0),
          registryValue("AllowedDrivers", 0),
          registryValue("Updates", 0),
          registryValue("AllowNightly", 0),
          registryValue("Telemetry", 0),
          registryValue("desktop", 0, "Clients"),
          registryValue("local-browser", 0, "Clients"),
          registryValue("remote", 0, "Clients"),
          registryValue("codex", 0, "AllowedDrivers"),
          registryValue("claudeAgent", 0, "AllowedDrivers"),
        ]),
        {
          document: {
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { telemetry: false },
          },
        },
      );
      // Anything the template does not write fails closed rather than being ignored.
      for (const [values, reason] of [
        [[organization, registryValue("Telemetry", 2)], "DWORD of 0 or 1"],
        [[organization, registryValue("MaxMode", "auto")], "not a T3 Code policy value"],
        [[organization, registryValue("x", 1, "Other")], "not a T3 Code policy key"],
        [[organization, registryValue("Settings", "{")], "not valid JSON"],
        [[organization, registryValue("Clients", 2)], "DWORD of 0 or 1"],
        [
          [organization, registryValue("Clients", 1), registryValue("desktop", 0, "Clients")],
          "does not match the policy schema",
        ],
        [[organization, registryValue("remote", 0, "Clients")], "does not match the policy schema"],
        [[registryValue("Organization", 1)], "Organization must be a string"],
        [[{ ...organization, type: "other" }], "Organization must be a string"],
        [
          [registryValue("MaxRuntimeMode", "auto-accept-edits")],
          "set the Organization policy whenever another T3 Code policy is set",
        ],
        [
          [registryValue("AllowedDrivers", 0), registryValue("Telemetry", 0)],
          "set the Organization policy whenever another T3 Code policy is set",
        ],
        [
          [registryValue("AllowedDrivers", 0), registryValue("MaxMode", "auto")],
          "not a T3 Code policy value",
        ],
        [[registryValue("Policy", "{}")], "Policy is not a T3 Code policy value"],
      ] as const) {
        assert.include(yield* read("win32", {}, registry(values)), reason);
      }
    }),
  );
});
