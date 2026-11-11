import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "./HostProcess.ts";

import {
  MACOS_MANAGED_PREFERENCES_PATH,
  managedPolicyPath,
  readManagedPolicy,
  type RegistryKey,
  WINDOWS_POLICY_KEY,
  layerWindowsRegistry,
  WindowsRegistry,
  WindowsRegistryError,
} from "./managedPolicyFile.ts";

const policy = JSON.stringify({ schemaVersion: 1, organization: "Example Corp" });

/** What a command prints and exits with. */
type Result = { readonly stdout: string; readonly exitCode: number };

/** Keys below the policy key ("" for the key itself), or the error every read fails with. */
type RegistryAnswer = Readonly<Record<string, RegistryKey>> | WindowsRegistryError;
const isRegistryError = Schema.is(WindowsRegistryError);
const POLICY_SUBKEY = WINDOWS_POLICY_KEY.slice("HKLM\\".length);

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
        readMachineKey: (subkey) =>
          isRegistryError(registry)
            ? Effect.fail(registry)
            : Effect.succeed(registry[subkey.slice(POLICY_SUBKEY.length + 1)]),
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

/** A policy key holding `values`, with checkbox subkeys of `name=0|1` entries. */
const policyKey = (
  values: RegistryKey["values"],
  subkeys: Readonly<Record<string, Readonly<Record<string, number>>>> = {},
): Readonly<Record<string, RegistryKey>> => ({
  "": { values, subkeys: Object.keys(subkeys) },
  ...Object.fromEntries(
    Object.entries(subkeys).map(([name, boxes]) => [
      name,
      {
        values: Object.entries(boxes).map(([box, data]) => ({
          name: box,
          type: "REG_DWORD" as const,
          data,
        })),
        subkeys: [],
      },
    ]),
  ),
});
const text = (name: string, data: string) => ({ name, type: "REG_SZ" as const, data });
const dword = (name: string, data: number) => ({ name, type: "REG_DWORD" as const, data });

const read = (
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string>>,
  commands: Parameters<typeof machine>[1] = {},
  registry: RegistryAnswer = {},
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
    "reads a Policy value of JSON from the registry, and treats only an absent key as none",
    () =>
      Effect.gen(function* () {
        const file = { [managedPolicyPath("win32")]: policy };
        const win32 = (files: Readonly<Record<string, string>>, registry: RegistryAnswer) =>
          read("win32", files, {}, registry);
        const json = policyKey([text("Policy", policy)]);

        assert.equal(yield* win32({}, json), WINDOWS_POLICY_KEY);
        assert.isUndefined(yield* win32({}, {}));
        assert.equal(yield* win32(file, {}), managedPolicyPath("win32"));
        assert.include(yield* win32(file, json), "deploy the policy one way");
        // A read that fails, here access denied, is not read as no policy, file or not.
        for (const files of [{}, file]) {
          assert.include(
            yield* win32(files, new WindowsRegistryError({ code: 5 })),
            "the registry cannot be read (Windows error 5)",
          );
        }
        assert.include(
          yield* win32({}, new WindowsRegistryError({})),
          "cannot load its registry reader; reinstall T3 Code",
        );
        assert.include(
          yield* win32({}, policyKey([{ name: "Policy", type: "other" }])),
          "its Policy value is not a string (REG_SZ)",
        );
        assert.include(
          yield* win32({}, policyKey([text("Policy", "{ not json")])),
          "does not match the policy schema",
        );
        for (const both of [
          policyKey([text("Policy", policy), text("Organization", "Example")]),
          policyKey([text("Policy", policy)], { Clients: { desktop: 1 } }),
        ]) {
          assert.include(yield* win32({}, both), "both a Policy value and Group Policy settings");
        }
        // Not Configured clears a list policy's values but can leave its empty subkey behind.
        assert.equal(
          yield* win32({}, policyKey([text("Policy", policy)], { Clients: {} })),
          WINDOWS_POLICY_KEY,
        );
      }),
  );

  it.effect("builds the policy from the values the Group Policy template writes", () =>
    Effect.gen(function* () {
      const organization = text("Organization", "Société 日本 ✓");
      const document = (registry: RegistryAnswer) =>
        readManagedPolicy("win32", ["codex", "claudeAgent"]).pipe(
          Effect.map((found): unknown => found?.document),
          Effect.catchTags({
            ManagedPolicyFileError: (error) => Effect.succeed(`error: ${error.reason}`),
          }),
          Effect.provide(machine({}, {}, registry)),
        );

      assert.deepStrictEqual(
        yield* document(
          policyKey(
            [
              organization,
              text("SupportUrl", ""),
              // Registry names ignore case.
              text("maxRuntimeMode", "auto-accept-edits"),
              dword("Telemetry", 0),
              text("Settings", '{"enableAgentBrowserAccess": {"value": false, "locked": true}}'),
              text("UpdatesMode", "off"),
              dword("AllowNightly", 1),
              dword("Updates", 1),
              dword("Clients", 1),
              dword("AllowedDrivers", 1),
            ],
            // Registry names ignore case, so a subkey written in other case still counts.
            {
              clients: { Desktop: 1, "LOCAL-BROWSER": 1, REMOTE: 1 },
              AllowedDrivers: { Codex: 1, CLAUDEAGENT: 1, UnknownDriver: 1 },
            },
          ),
        ),
        {
          schemaVersion: 1,
          organization: "Société 日本 ✓",
          settings: { enableAgentBrowserAccess: { value: false, locked: true } },
          limits: {
            maxRuntimeMode: "auto-accept-edits",
            telemetry: false,
            updates: { mode: "off", allowNightly: true },
            clients: ["desktop", "local-browser", "remote"],
            providers: { allowedDrivers: ["codex", "claudeAgent", "UnknownDriver"] },
          },
        },
      );

      // Disabling a policy leaves each checkbox's falseValue behind; it restricts nothing.
      const disabledGroups = {
        Clients: { desktop: 0, "local-browser": 0, remote: 0 },
        AllowedDrivers: { codex: 0, claudeAgent: 0 },
      };
      assert.deepStrictEqual(
        yield* document(
          policyKey(
            [
              organization,
              dword("Clients", 0),
              dword("AllowedDrivers", 0),
              dword("Updates", 0),
              dword("AllowNightly", 0),
              dword("Telemetry", 0),
            ],
            disabledGroups,
          ),
        ),
        { schemaVersion: 1, organization: "Société 日本 ✓", limits: { telemetry: false } },
      );
      // With nothing else configured, that is no policy rather than one missing Organization.
      assert.isUndefined(
        yield* document(
          policyKey([dword("AllowedDrivers", 0)], {
            AllowedDrivers: disabledGroups.AllowedDrivers,
          }),
        ),
      );
      assert.isUndefined(yield* document(policyKey([])));

      // Anything the template does not write fails closed rather than being ignored.
      for (const [registry, reason] of [
        [policyKey([organization, dword("Telemetry", 2)]), "DWORD of 0 or 1"],
        [policyKey([organization, text("MaxMode", "auto")]), "not a T3 Code policy value"],
        [policyKey([organization], { Other: { x: 1 } }), "Other is not a T3 Code policy key"],
        [
          {
            ...policyKey([organization, dword("Clients", 1)], { Clients: { desktop: 1 } }),
            Clients: { values: [dword("desktop", 1)], subkeys: ["Nested"] },
          },
          "Clients\\Nested is not a T3 Code policy key",
        ],
        [policyKey([organization, text("Settings", "{")]), "not valid JSON"],
        [policyKey([organization, dword("Clients", 2)]), "DWORD of 0 or 1"],
        [
          policyKey([organization, dword("Clients", 1)], { Clients: { UnknownClient: 1 } }),
          "does not match the policy schema",
        ],
        [
          policyKey([organization, dword("Clients", 1)], { Clients: { desktop: 0 } }),
          "does not match the policy schema",
        ],
        [policyKey([dword("Organization", 1)]), "Organization must be a string"],
        // REG_EXPAND_SZ would fill in the reading user's variables.
        [policyKey([{ name: "Organization", type: "other" }]), "Organization must be a string"],
        [
          policyKey([text("MaxRuntimeMode", "auto-accept-edits")]),
          "set the Organization policy whenever another T3 Code policy is set",
        ],
      ] as const) {
        assert.include(yield* document(registry), reason);
      }
    }),
  );

  it.effect.runIf(HostProcess.Platform.defaultValue() === "win32")(
    "lists registry values and subkeys through the Win32 API",
    () =>
      Effect.gen(function* () {
        const registry = yield* WindowsRegistry;
        const version = yield* registry.readMachineKey(
          "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
        );
        const value = (name: string) => version?.values.find((entry) => entry.name === name);
        const product = value("ProductName");
        assert.match(product?.type === "REG_SZ" ? product.data : "", /Windows/);
        assert.equal(value("CurrentMajorVersionNumber")?.type, "REG_DWORD");
        assert.isUndefined(yield* registry.readMachineKey("SOFTWARE\\T3CodeNoSuchKey"));
        const windows = yield* registry.readMachineKey(
          "SOFTWARE\\Microsoft\\Windows\\CurrentVersion",
        );
        // REG_EXPAND_SZ, which would otherwise expand the user's variables.
        assert.equal(
          windows?.values.find((entry) => entry.name === "ProgramFilesPath")?.type,
          "other",
        );
        const parent = yield* registry.readMachineKey("SOFTWARE\\Microsoft\\Windows NT");
        assert.isTrue(parent?.subkeys.includes("CurrentVersion"));
      }).pipe(Effect.provide(layerWindowsRegistry(() => import("ffi-rs")))),
  );
});
