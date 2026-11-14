import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  type ManagedPolicyDocument,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  SecretProviderId,
  ServerSettings,
  ServerSettingsPatch,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SchemaAST from "effect/SchemaAST";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { sourceControlHostSecretName } from "./sourceControl/sourceControlHostSecrets.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerSettingsModule from "./serverSettings.ts";
import { SECRET_REDACTED } from "./settingsSecrets.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

/** Paths of fields typed `SettingsSecretValue` that clients decode with the settings schema itself. */



import { decodeServerSettings, decodeServerSettingsJson, decodeServerSettingsPatch, layerServerSettings, layerServerSettingsWithSecrets, layerFailingSecretStore, recordProviderUsage, strictSecretReferencePaths } from "./serverSettings-fixtures.testkit.ts";
it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "server settings under a managed policy",
  (it) => {
    const policy: ManagedPolicyDocument = {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: {
        defaultRuntimeMode: { value: "approval-required", locked: false },
        enableAgentDeviceAccess: { value: false, locked: true },
      },
    };

    it.effect("uses policy defaults until the user picks something else", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;

        assert.equal((yield* service.getSettings).defaultRuntimeMode, "approval-required");

        // The built-in default differs from the policy's, so choosing it must persist.
        yield* service.updateSettings({ defaultRuntimeMode: "full-access" });
        assert.equal((yield* service.getSettings).defaultRuntimeMode, "full-access");
        assert.include(yield* fs.readFileString(config.settingsPath), '"full-access"');

        // Choosing the policy's value leaves nothing in the file to outlive the policy.
        yield* service.updateSettings({ defaultRuntimeMode: "approval-required" });
        assert.notInclude(yield* fs.readFileString(config.settingsPath), "defaultRuntimeMode");
      }).pipe(Effect.provide(layerServerSettings(policy))),
    );

    it.effect("keeps a stored value that equals a policy default through unrelated writes", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ defaultRuntimeMode: "approval-required" }),
        );

        yield* service.updateSettings({ defaultAutoPull: true });
        assert.include(yield* fs.readFileString(config.settingsPath), '"approval-required"');
      }).pipe(Effect.provide(layerServerSettings(policy))),
    );

    it.effect("keeps stored values under whole-object policy defaults, and only the user's", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const selection = {
          ...DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
          model: "managed",
        };
        const chosenModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-mini" };
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            storageCleanup: { logsAfterDays: 30, browserArtifactsAfterDays: 7 },
            textGenerationModelSelection: selection,
          }),
        );

        // Picking another model on the policy's instance differs from the policy in one field only.
        yield* service.updateSettings({
          defaultAutoPull: true,
          defaultModelSelection: chosenModel,
        });
        const stored = JSON.parse(yield* fs.readFileString(config.settingsPath));
        assert.deepEqual(stored.storageCleanup, {
          logsAfterDays: 30,
          browserArtifactsAfterDays: 7,
        });
        // Model selections are saved whole, never as the fields that differ from the policy's.
        assert.deepEqual(stored.textGenerationModelSelection, selection);
        assert.deepEqual(stored.defaultModelSelection, chosenModel);
        // The switch the server derives from the policy's idle compaction stays out of the file.
        assert.notProperty(stored, "compactIdleThreads");
      }).pipe(
        Effect.provide(
          layerServerSettings({
            schemaVersion: 1,
            organization: "Example Corp",
            settings: {
              storageCleanup: {
                value: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, logsAfterDays: 30 },
                locked: false,
              },
              "textGenerationModelSelection.model": { value: "managed", locked: false },
              defaultModelSelection: {
                value: { instanceId: "codex", model: "gpt-managed" },
                locked: false,
              },
              idleCompaction: { value: "beforeCacheExpires", locked: false },
            },
          }),
        ),
      ),
    );

    it.effect(
      "keeps an idle compaction choice saved before idleCompaction over a policy default",
      () =>
        // The file holds only the legacy switch: off differs from the policy's default, on matches it.
        Effect.forEach([false, true], (compactIdleThreads) =>
          Effect.gen(function* () {
            const service = yield* ServerSettingsModule.ServerSettingsService;
            const config = yield* ServerConfig.ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            const chosen = compactIdleThreads ? "beforeCacheExpires" : "onReturn";
            yield* fs.writeFileString(config.settingsPath, JSON.stringify({ compactIdleThreads }));

            assert.equal((yield* service.getSettings).idleCompaction, chosen);
            yield* service.updateSettings({ defaultAutoPull: true });
            // What applies once the policy is gone is still the user's choice.
            const stored = JSON.parse(yield* fs.readFileString(config.settingsPath));
            assert.equal(globalIdleCompaction(stored), chosen);
          }).pipe(
            Effect.provide(
              layerServerSettings({
                schemaVersion: 1,
                organization: "Example Corp",
                settings: { idleCompaction: { value: "beforeCacheExpires", locked: false } },
              }),
            ),
          ),
        ),
    );

    it.effect("lays locks over the user's own and per-project values without persisting them", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const projectId = ProjectId.make("project-locked");
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            enableAgentDeviceAccess: true,
            projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } },
          }),
        );

        const settings = yield* service.getSettings;
        assert.isFalse(settings.enableAgentDeviceAccess);
        assert.isFalse(settings.projectSettingsOverrides[projectId]?.enableAgentDeviceAccess);
        assert.deepEqual(service.managedPolicy, {
          organization: "Example Corp",
          lockedSettings: ["enableAgentDeviceAccess"],
        });

        const rejected = yield* service
          .updateSettings({ enableAgentDeviceAccess: true, defaultAutoPull: true })
          .pipe(Effect.flip);
        assert.equal(rejected.operation, "write-managed-setting");
        assert.equal(rejected.managedSetting, "enableAgentDeviceAccess");
        assert.equal(
          rejected.message,
          "enableAgentDeviceAccess is managed by Example Corp and cannot be changed.",
        );
        assert.isFalse((yield* service.getSettings).defaultAutoPull);

        const projectRejected = yield* service
          .updateSettings({
            projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } },
          })
          .pipe(Effect.flip);
        assert.equal(projectRejected.managedSetting, "enableAgentDeviceAccess");

        // Unrelated writes, and writes that keep the locked value, go through.
        yield* service.updateSettings({ enableAgentDeviceAccess: false, defaultAutoPull: true });
        assert.isTrue((yield* service.getSettings).defaultAutoPull);

        // The user's own value stays on disk, ready for when the policy is removed.
        const stored = JSON.parse(yield* fs.readFileString(config.settingsPath));
        assert.isTrue(stored.enableAgentDeviceAccess);
      }).pipe(Effect.provide(layerServerSettings(policy))),
    );
    it.effect("accepts a project override that brings the locked value inside a new setting", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const projectId = ProjectId.make("project-text-generation");
        const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-locked" };

        yield* service.updateSettings({
          projectSettingsOverrides: { [projectId]: { textGenerationModelSelection: selection } },
        });

        const project = (yield* service.getSettings).projectSettingsOverrides[projectId];
        assert.equal(project?.textGenerationModelSelection?.model, "gpt-locked");
      }).pipe(
        Effect.provide(
          layerServerSettings({
            schemaVersion: 1,
            organization: "Example Corp",
            settings: {
              "textGenerationModelSelection.model": { value: "gpt-locked", locked: true },
            },
          }),
        ),
      ),
    );

    it.effect(
      "compares a project's partial override with a locked entry by the keys it holds",
      () =>
        Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const codexId = ProviderInstanceId.make("codex");
          const projectWith = (enabled: boolean) => ({
            projectSettingsOverrides: {
              [ProjectId.make("project-codex")]: { providerInstances: { [codexId]: { enabled } } },
            },
          });

          yield* service.updateSettings(projectWith(true));
          const refused = yield* service.updateSettings(projectWith(false)).pipe(Effect.flip);
          assert.equal(refused.managedSetting, "providerInstances.codex");
        }).pipe(
          Effect.provide(
            layerServerSettings({
              schemaVersion: 1,
              organization: "Example Corp",
              settings: {
                "providerInstances.codex": {
                  value: { driver: "codex", enabled: true },
                  locked: true,
                },
              },
            }),
          ),
        ),
    );

    it.effect("lowers default runtime modes above the ceiling without rewriting them", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const raised = ProjectId.make("project-raised");
        const supervised = ProjectId.make("project-supervised");
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            defaultRuntimeMode: "auto",
            projectSettingsOverrides: {
              [raised]: { defaultRuntimeMode: "full-access" },
              [supervised]: { defaultRuntimeMode: "approval-required" },
            },
          }),
        );

        const settings = yield* service.getSettings;
        assert.equal(settings.defaultRuntimeMode, "auto-accept-edits");
        assert.equal(
          settings.projectSettingsOverrides[raised]?.defaultRuntimeMode,
          "auto-accept-edits",
        );
        assert.equal(
          settings.projectSettingsOverrides[supervised]?.defaultRuntimeMode,
          "approval-required",
        );

        yield* service.updateSettings({ defaultAutoPull: true });
        const stored = JSON.parse(yield* fs.readFileString(config.settingsPath));
        assert.equal(stored.defaultRuntimeMode, "auto");
        assert.equal(stored.projectSettingsOverrides[raised].defaultRuntimeMode, "full-access");
      }).pipe(
        Effect.provide(
          layerServerSettings({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { maxRuntimeMode: "auto-accept-edits" },
          }),
        ),
      ),
    );
  },
);
it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "server settings under a provider policy",
  (it) => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const codex = ProviderDriverKind.make("codex");
    const cursor = ProviderDriverKind.make("cursor");
    const bedrock = { name: "CLAUDE_CODE_USE_BEDROCK", value: "1", sensitive: false };
    const policy: ManagedPolicyDocument = {
      schemaVersion: 1,
      organization: "Example Corp",
      limits: {
        providers: {
          allowedDrivers: [claude, codex],
          instances: {
            [claude]: {
              locked: true,
              environment: [{ name: bedrock.name, value: bedrock.value }],
              binaryPath: "/opt/claude/bin/claude",
            },
            [codex]: { locked: false, launchArgs: "-c model_provider=gateway" },
          },
        },
      },
    };

    it.effect("refuses enabling a driver the policy leaves out, and keeps existing ones", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const cursorId = ProviderInstanceId.make("cursor_work");
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providerInstances: {
              [cursorId]: { driver: cursor, enabled: true },
              // A default instance id is no proof of its driver.
              codex: { driver: cursor, enabled: true },
            },
            textGenerationModelSelection: { instanceId: cursorId, model: "auto" },
          }),
        );

        const settings = yield* service.getSettings;
        // Never deleted: the instance stays for its threads, and the registry shows it unavailable.
        assert.equal(settings.providerInstances[cursorId]?.driver, cursor);
        // Built-in text generation does not fall back onto a disallowed driver either.
        assert.equal(settings.textGenerationModelSelection.instanceId, "claudeAgent");

        const rejected = yield* service
          .updateProviderInstance({
            operation: "create",
            instanceId: ProviderInstanceId.make("cursor_new"),
            instance: { driver: cursor, enabled: true },
          })
          .pipe(Effect.flip);
        assert.equal(rejected.operation, "use-disallowed-provider");
        assert.equal(rejected.message, "Example Corp's policy does not allow the Cursor provider.");
        // Switching it on for one project is enabling it too.
        const perProject = yield* service
          .updateSettings({
            projectSettingsOverrides: {
              [ProjectId.make("project-a")]: {
                providerInstances: { [cursorId]: { enabled: true } },
              },
            },
          })
          .pipe(Effect.flip);
        assert.equal(perProject.operation, "use-disallowed-provider");

        // The client echoes a default instance that was running before it was configured.
        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: ProviderInstanceId.make("cursor"),
          instance: { driver: cursor, enabled: true },
        });

        // Turning it off, or removing it, is still the user's call.
        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: cursorId,
          instance: { driver: cursor, enabled: false },
        });
        yield* service.updateProviderInstance({ operation: "remove", instanceId: cursorId });
        assert.isUndefined((yield* service.getSettings).providerInstances[cursorId]);
      }).pipe(Effect.provide(layerServerSettings(policy))),
    );

    it.effect("keeps a locked Codex pin from being bypassed by managed setup", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const codexId = ProviderInstanceId.make("codex_chatgpt");
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providerInstances: { [codexId]: { driver: codex, config: { setupMode: "managed" } } },
          }),
        );

        const effective = (yield* service.getSettings).providerInstances[codexId];
        assert.deepEqual(effective?.config, { binaryPath: "/opt/gateway/codex" });
        // A stored value stays for when the policy is gone; a new one is refused.
        const refused = yield* service
          .updateProviderInstance({
            operation: "upsert",
            instanceId: ProviderInstanceId.make("codex_new"),
            instance: { driver: codex, config: { setupMode: "managed" } },
          })
          .pipe(Effect.flip);
        assert.equal(refused.managedSetting, "providerInstances.codex_new.config.setupMode");
        // Adding a Codex instance sends the default setup, which leaves the pin in charge.
        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_cli"),
          instance: { driver: codex, config: { setupMode: "existing" } },
        });
      }).pipe(
        Effect.provide(
          layerServerSettings({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: {
              providers: {
                instances: { [codex]: { locked: true, binaryPath: "/opt/gateway/codex" } },
              },
            },
          }),
        ),
      ),
    );

    it.effect("pins instance fields at read time and refuses edits to locked ones", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const claudeId = ProviderInstanceId.make("claudeAgent");
        const codexId = ProviderInstanceId.make("codex");
        const userVariable = { name: "MY_FLAG", value: "on", sensitive: false };
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providerInstances: {
              [claudeId]: {
                driver: claude,
                environment: [{ ...bedrock, value: "0" }, userVariable, { ...bedrock, value: "2" }],
                config: { binaryPath: "/usr/local/bin/claude" },
              },
            },
          }),
        );

        const effective = yield* service.getSettings;
        const claudeInstance = effective.providerInstances[claudeId];
        assert.deepEqual(claudeInstance?.environment, [bedrock, userVariable]);
        assert.deepEqual(claudeInstance?.config, { binaryPath: "/opt/claude/bin/claude" });
        // The implicit default Codex instance gets the unlocked default too.
        assert.deepEqual(effective.providerInstances[codexId]?.config, {
          launchArgs: "-c model_provider=gateway",
        });

        const lockedBinary = yield* service
          .updateProviderInstance({
            operation: "upsert",
            instanceId: claudeId,
            instance: { ...claudeInstance!, config: { binaryPath: "/tmp/claude" } },
          })
          .pipe(Effect.flip);
        assert.equal(lockedBinary.operation, "write-managed-setting");
        assert.equal(
          lockedBinary.managedSetting,
          "providerInstances.claudeAgent.config.binaryPath",
        );
        const lockedVariable = yield* service
          .updateProviderInstance({
            operation: "upsert",
            instanceId: claudeId,
            instance: { ...claudeInstance!, environment: [userVariable] },
          })
          .pipe(Effect.flip);
        assert.equal(
          lockedVariable.managedSetting,
          "providerInstances.claudeAgent.environment.CLAUDE_CODE_USE_BEDROCK",
        );

        // Saving what the client was shown, plus an unrelated edit, goes through without baking
        // the policy into the file: the user's own values come back once the policy is removed.
        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: claudeId,
          instance: { ...claudeInstance!, displayName: "Claude (work)" },
        });
        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: codexId,
          instance: effective.providerInstances[codexId]!,
        });
        const stored = JSON.parse(yield* fs.readFileString(config.settingsPath));
        assert.deepEqual(stored.providerInstances[claudeId], {
          driver: claude,
          displayName: "Claude (work)",
          environment: [{ ...bedrock, value: "0" }, { ...bedrock, value: "2" }, userVariable],
          config: { binaryPath: "/usr/local/bin/claude" },
        });
        assert.isUndefined(stored.providerInstances[codexId]);

        // Unlocked fields are the user's to override.
        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: codexId,
          instance: { driver: codex, config: { launchArgs: "--mine" } },
        });
        assert.deepEqual((yield* service.getSettings).providerInstances[codexId]?.config, {
          launchArgs: "--mine",
        });
      }).pipe(Effect.provide(layerServerSettings(policy))),
    );
  },
);
