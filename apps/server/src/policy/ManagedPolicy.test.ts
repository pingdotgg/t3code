import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ManagedPolicy from "./ManagedPolicy.ts";
import { disallowedDriverReason, providerHostEnvironment } from "./managedProviders.ts";

it.layer(NodeServices.layer)("ManagedPolicy.load", (it) => {
  const loadFrom = (contents: string | undefined) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-policy-" });
      const file = path.join(dir, "policy.json");
      if (contents !== undefined) yield* fs.writeFileString(file, contents);
      return yield* ManagedPolicy.load(file);
    }).pipe(Effect.scoped);

  it.effect("means no policy when the file is missing", () =>
    Effect.gen(function* () {
      const policy = yield* loadFrom(undefined);
      assert.isUndefined(policy.summary);
    }),
  );

  it.effect("summarizes locked settings for clients", () =>
    Effect.gen(function* () {
      const policy = yield* loadFrom(
        JSON.stringify({
          schemaVersion: 1,
          organization: "Example Corp",
          supportUrl: "https://it.example/t3",
          settings: {
            "storageCleanup.logsAfterDays": { value: 30, locked: true },
            defaultRuntimeMode: { value: "approval-required", locked: false },
          },
        }),
      );
      assert.deepEqual(policy.summary, {
        organization: "Example Corp",
        supportUrl: "https://it.example/t3",
        lockedSettings: ["storageCleanup.logsAfterDays"],
      });
    }),
  );

  it.effect("tells clients which capabilities the policy switches off", () =>
    Effect.gen(function* () {
      const policy = yield* loadFrom(
        JSON.stringify({
          schemaVersion: 1,
          organization: "Example Corp",
          limits: { webhookTasks: false, telemetry: true },
        }),
      );
      assert.deepEqual(policy.summary?.limits, { webhookTasks: false, telemetry: true });
      assert.equal(ManagedPolicy.deniedBy(policy, "webhookTasks"), "Example Corp");
      assert.isUndefined(ManagedPolicy.deniedBy(policy, "telemetry"));
    }),
  );

  it.effect("refuses files it cannot fully enforce", () =>
    Effect.gen(function* () {
      const base = { schemaVersion: 1, organization: "Example Corp" };
      const reasons = yield* Effect.forEach(
        [
          "{ not json",
          // An unknown key may be a restriction from a newer release.
          JSON.stringify({ ...base, limits: { connect: false, futureLimit: true } }),
          JSON.stringify({ ...base, settings: { notASetting: { value: 1, locked: true } } }),
          JSON.stringify({
            ...base,
            settings: { "storageCleanup.logsAfterDayz": { value: 30, locked: true } },
          }),
          JSON.stringify({
            ...base,
            settings: { defaultRuntimeMode: { value: "yolo", locked: true } },
          }),
          JSON.stringify({
            ...base,
            settings: { projectSettingsOverrides: { value: {}, locked: true } },
          }),
          // The user could never remove a provider instance a default keeps adding back.
          JSON.stringify({
            ...base,
            settings: {
              "providerInstances.codex_work": {
                value: { driver: "codex", enabled: true },
                locked: false,
              },
            },
          }),
          JSON.stringify({
            ...base,
            settings: {
              providerInstances: { value: { codex_work: { driver: "codex" } }, locked: false },
            },
          }),
          // A user's stored null would leave the lock building half a model selection.
          JSON.stringify({
            ...base,
            settings: { "defaultModelSelection.model": { value: "gpt-5.4", locked: true } },
          }),
          // The server derives it from idleCompaction on every write.
          JSON.stringify({
            ...base,
            settings: { compactIdleThreads: { value: false, locked: true } },
          }),
          // It would look locked while worktreeCleanup, which overrides it, stays the user's.
          JSON.stringify({
            ...base,
            settings: { "storageCleanup.worktreeAfterDays": { value: 7, locked: true } },
          }),
          // An instance's own variables, home paths, and setup mode would override the lock.
          JSON.stringify({
            ...base,
            settings: {
              "providerInstances.codex.driver": { value: "codex", locked: true },
              "providerInstances.codex.config.launchArgs": {
                value: "-c model_provider=corp",
                locked: true,
              },
            },
          }),
          // The server would move it into the user's secret store, past the policy's removal.
          JSON.stringify({
            ...base,
            settings: {
              providerInstances: {
                value: { gemini: { driver: "antigravity", config: { apiKey: "corp-key" } } },
                locked: true,
              },
            },
          }),
        ],
        (contents) =>
          loadFrom(contents).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
      );
      assert.lengthOf(reasons, 13);
      assert.include(reasons[3], "storageCleanup.logsAfterDayz");
      assert.include(reasons[6], "adds entries users could not remove");
      assert.include(reasons[7], "adds entries users could not remove");
      assert.include(reasons[8], 'manage "defaultModelSelection" as a whole');
      assert.include(reasons[9], 'manage "idleCompaction" instead');
      assert.include(reasons[10], 'lock "worktreeCleanup" too');
      assert.include(reasons[11], 'lock "providerInstances.codex" as a whole');
      assert.include(reasons[12], "holds a credential");
    }),
  );

  it.effect("tells clients the runtime mode ceiling", () =>
    Effect.gen(function* () {
      const policy = yield* loadFrom(
        JSON.stringify({
          schemaVersion: 1,
          organization: "Example Corp",
          settings: { defaultRuntimeMode: { value: "approval-required", locked: true } },
          limits: { maxRuntimeMode: "auto-accept-edits" },
        }),
      );
      const { providers, ...limits } = policy.summary?.limits ?? {};
      assert.deepEqual(limits, { maxRuntimeMode: "auto-accept-edits" });
      // Under a ceiling, each driver's launch configuration is the administrator's.
      assert.deepEqual(providers?.lockedInstanceFields?.[ProviderDriverKind.make("claudeAgent")], [
        "config.binaryPath",
        "config.launchArgs",
        "config.homePath",
        "environment",
      ]);
      assert.deepEqual(providers?.lockedInstanceFields?.[ProviderDriverKind.make("acpRegistry")], [
        "config.commandPath",
        "config.commandArgs",
        "environment",
      ]);
      // The host variable that replaces Codex's launch arguments is ignored too.
      const host = { PATH: "/usr/bin", T3CODE_CODEX_LAUNCH_ARGS: "-c mcp_servers.x.command=sh" };
      assert.deepEqual(providerHostEnvironment(policy.summary, host), { PATH: "/usr/bin" });
      assert.strictEqual(providerHostEnvironment(undefined, host), host);
    }),
  );

  it.effect(
    "locks a variable in every spelling on Windows only, and drops a Codex launch override",
    () =>
      Effect.gen(function* () {
        const codex = ProviderDriverKind.make("codex");
        const variable = (name: string, value: string) => ({ name, value, sensitive: false });
        const settings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            codex: {
              driver: codex,
              environment: [
                variable("HTTPS_PROXY", "http://mine"),
                variable("T3CODE_CODEX_LAUNCH_ARGS", "--dangerously-bypass-approvals-and-sandbox"),
              ],
            },
          },
        };
        const policyOn = (platform: NodeJS.Platform) =>
          ManagedPolicy.fromDocument("/test/policy.json", {
            schemaVersion: 1,
            organization: "Example Corp",
            limits: {
              providers: {
                instances: {
                  [codex]: {
                    locked: true,
                    launchArgs: "--strict-config",
                    environment: [{ name: "Https_Proxy", value: "http://gateway" }],
                  },
                },
              },
            },
          }).pipe(Effect.provideService(HostProcess.Platform, platform));
        const environmentOn = (platform: NodeJS.Platform) =>
          Effect.map(
            policyOn(platform),
            (policy) =>
              policy.providers.applyLimits(settings).providerInstances[
                ProviderInstanceId.make("codex")
              ]?.environment,
          );
        assert.deepEqual(yield* environmentOn("win32"), [
          variable("Https_Proxy", "http://gateway"),
        ]);
        assert.deepEqual(yield* environmentOn("linux"), [
          variable("HTTPS_PROXY", "http://mine"),
          variable("Https_Proxy", "http://gateway"),
        ]);
        // Saving what the client was shown keeps the override it never saw.
        const linux = yield* policyOn("linux");
        const shown = linux.providers.applyLimits(settings);
        const codexId = ProviderInstanceId.make("codex");
        const saved = linux.providers.vetWrite(settings, {
          ...shown,
          providerInstances: {
            ...shown.providerInstances,
            [codexId]: { ...shown.providerInstances[codexId]!, displayName: "Codex (work)" },
          },
        });
        assert.equal(saved._tag, "Allowed");
        const savedEnvironment =
          saved._tag === "Allowed"
            ? (saved.settings.providerInstances[codexId]?.environment ?? [])
            : [];
        assert.isTrue(savedEnvironment.some((entry) => entry.name === "T3CODE_CODEX_LAUNCH_ARGS"));
        // A home path setting would rewrite a locked home variable at launch, so the lock owns it.
        const claude = ProviderDriverKind.make("claudeAgent");
        const homeLocked = yield* ManagedPolicy.fromDocument("/test/policy.json", {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: {
            providers: {
              instances: {
                [claude]: {
                  locked: true,
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/opt/claude-home" }],
                },
              },
            },
          },
        });
        const claudeId = ProviderInstanceId.make("claudeAgent");
        const claudeConfig = homeLocked.providers.applyLimits({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [claudeId]: { driver: claude, config: { homePath: "/home/me/.other-claude" } },
          },
        }).providerInstances[claudeId]?.config;
        assert.deepEqual(claudeConfig, {});
        assert.include(
          homeLocked.summary?.limits?.providers?.lockedInstanceFields?.[claude] ?? [],
          "config.homePath",
        );
        // Codex has a second home setting, which a locked CODEX_HOME owns too.
        const codexHome = yield* ManagedPolicy.fromDocument("/test/policy.json", {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: {
            providers: {
              instances: {
                [codex]: {
                  locked: true,
                  environment: [{ name: "CODEX_HOME", value: "/opt/codex-home" }],
                },
              },
            },
          },
        });
        assert.includeMembers(
          [...(codexHome.summary?.limits?.providers?.lockedInstanceFields?.[codex] ?? [])],
          ["config.homePath", "config.shadowHomePath"],
        );
        // A server URL makes OpenCode skip the local launch a pin sets, so the pin owns it too.
        const opencode = ProviderDriverKind.make("opencode");
        const opencodePinned = yield* ManagedPolicy.fromDocument("/test/policy.json", {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: {
            providers: { instances: { [opencode]: { locked: true, binaryPath: "/opt/opencode" } } },
          },
        });
        assert.include(
          opencodePinned.summary?.limits?.providers?.lockedInstanceFields?.[opencode] ?? [],
          "config.serverUrl",
        );
        // The same override from the environment that starts the server is ignored too.
        const host = { PATH: "/usr/bin", T3CODE_CODEX_LAUNCH_ARGS: "--yolo" };
        assert.deepEqual(providerHostEnvironment((yield* policyOn("linux")).summary, host), {
          PATH: "/usr/bin",
        });
      }),
  );

  it.effect("refuses a default runtime mode above its own ceiling", () =>
    Effect.gen(function* () {
      const reasons = yield* Effect.forEach([false, true], (locked) =>
        loadFrom(
          JSON.stringify({
            schemaVersion: 1,
            organization: "Example Corp",
            settings: { defaultRuntimeMode: { value: "auto", locked } },
            limits: { maxRuntimeMode: "auto-accept-edits" },
          }),
        ).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        ),
      );
      assert.deepEqual(reasons, [
        '"defaultRuntimeMode" is above "limits.maxRuntimeMode"',
        '"defaultRuntimeMode" is above "limits.maxRuntimeMode"',
      ]);
    }),
  );

  it.effect("tells clients which drivers run and which instance fields are locked", () =>
    Effect.gen(function* () {
      const policy = yield* loadFrom(
        JSON.stringify({
          schemaVersion: 1,
          organization: "Example Corp",
          limits: {
            providers: {
              allowedDrivers: ["claudeAgent", "codex"],
              instances: {
                claudeAgent: {
                  locked: true,
                  environment: [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }],
                  binaryPath: "/opt/claude/bin/claude",
                },
                codex: { locked: false, launchArgs: "-c model_provider=gateway" },
              },
            },
          },
        }),
      );
      assert.deepEqual<unknown>(policy.summary?.limits, {
        providers: {
          allowedDrivers: ["claudeAgent", "codex"],
          lockedInstanceFields: {
            claudeAgent: ["config.binaryPath", "environment.CLAUDE_CODE_USE_BEDROCK"],
          },
        },
      });
      assert.equal(
        disallowedDriverReason(policy.summary, ProviderDriverKind.make("cursor")),
        "Example Corp's policy does not allow the Cursor provider.",
      );
      assert.isUndefined(disallowedDriverReason(policy.summary, ProviderDriverKind.make("codex")));
    }),
  );

  it.effect("refuses provider limits it cannot enforce", () =>
    Effect.gen(function* () {
      const withProviders = (providers: unknown) =>
        JSON.stringify({
          schemaVersion: 1,
          organization: "Example Corp",
          limits: { providers },
        });
      const reasons = yield* Effect.forEach(
        [
          withProviders({ allowedDrivers: ["claudeAgent", "notAProvider"] }),
          withProviders({ instances: { notAProvider: { locked: true, binaryPath: "/x" } } }),
          // Cursor has no launch arguments setting to pin.
          withProviders({ instances: { cursor: { locked: true, launchArgs: "--x" } } }),
          withProviders({ instances: { codex: { locked: true, homePath: "/x" } } }),
          withProviders({
            instances: { codex: { locked: true, environment: [{ name: "1BAD", value: "" }] } },
          }),
          // No provider could run at all.
          withProviders({ allowedDrivers: [] }),
        ],
        (contents) =>
          loadFrom(contents).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
      );
      assert.lengthOf(reasons, 6);
      assert.include(reasons[0], "notAProvider");
      assert.include(reasons[1], "notAProvider");
      assert.include(reasons[2], "launchArgs");
    }),
  );

  it.effect(
    "tells clients how updates are managed and refuses an update feed it cannot trust",
    () =>
      Effect.gen(function* () {
        const base = { schemaVersion: 1, organization: "Example Corp" };
        const updates = {
          mode: "auto" as const,
          feedUrl: "https://updates.example/t3",
          allowNightly: false,
        };
        const policy = yield* loadFrom(JSON.stringify({ ...base, limits: { updates } }));
        const { feedUrl: _feedUrl, ...clientUpdates } = updates;
        assert.deepEqual(policy.summary?.limits, { updates: clientUpdates });
        for (const invalid of [
          { mode: "auto", feedUrl: "http://updates.example/t3" },
          { mode: "manual" },
          { mode: "sometimes" },
          { mode: "auto", pinVersion: "1.2.3" },
        ]) {
          yield* loadFrom(JSON.stringify({ ...base, limits: { updates: invalid } })).pipe(
            Effect.flip,
          );
        }
      }),
  );
});
