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
  "server settings under a runtime mode ceiling",
  (it) => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const acpRegistry = ProviderDriverKind.make("acpRegistry");
    const policy: ManagedPolicyDocument = {
      schemaVersion: 1,
      organization: "Example Corp",
      limits: {
        maxRuntimeMode: "auto-accept-edits",
        providers: {
          instances: {
            [claude]: {
              locked: false,
              environment: [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }],
              binaryPath: "/opt/claude/bin/claude",
            },
          },
        },
      },
    };

    it.effect("keeps the secret of a variable it hides when the instance is saved", () => {
      const shared = ServerSecretStore.layer.pipe(
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provideMerge(
          Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hidden-secret-" })),
        ),
      );
      const withPolicy = <A, E>(
        document: ManagedPolicyDocument | undefined,
        use: (
          service: ServerSettingsModule.ServerSettingsService["Service"],
        ) => Effect.Effect<A, E>,
      ) =>
        ServerSettingsModule.ServerSettingsService.pipe(
          Effect.flatMap(use),
          Effect.provide(
            ServerSettingsModule.layer.pipe(Layer.provide(ManagedPolicy.layerTest(document))),
          ),
        );
      const claudeId = ProviderInstanceId.make("claudeAgent");
      const token = { name: "ANTHROPIC_API_KEY", value: "sk-kept", sensitive: true };
      return Effect.gen(function* () {
        yield* withPolicy(undefined, (service) =>
          service.updateProviderInstance({
            operation: "upsert",
            instanceId: claudeId,
            instance: { driver: claude, environment: [token] },
          }),
        );
        // The ceiling shows only pinned variables, so the client saves without the token.
        yield* withPolicy(policy, (service) =>
          service.getSettings.pipe(
            Effect.flatMap((settings) =>
              service.updateProviderInstance({
                operation: "upsert",
                instanceId: claudeId,
                instance: {
                  ...settings.providerInstances[claudeId]!,
                  displayName: "Claude (work)",
                },
              }),
            ),
          ),
        );
        const restored = yield* withPolicy(undefined, (service) => service.getSettings);
        assert.equal(restored.providerInstances[claudeId]?.environment?.[0]?.value, token.value);
      }).pipe(Effect.provide(shared));
    });

    it.effect("ignores stored launch configuration and refuses new values", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const claudeId = ProviderInstanceId.make("claudeAgent");
        const registryId = ProviderInstanceId.make("acp_devin");
        const userVariable = {
          name: "CLAUDE_CONFIG_DIR",
          value: "/tmp/allow-all",
          sensitive: false,
        };
        const storedClaude = {
          driver: claude,
          environment: [userVariable, { ...userVariable, value: "/tmp/later-wins" }],
          config: {
            binaryPath: "/tmp/wrapper",
            launchArgs: "--dangerously-skip-permissions",
            homePath: "/tmp/allow-all",
            autoCompactWindow: "300000",
          },
        };
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providerInstances: {
              [claudeId]: storedClaude,
              [registryId]: {
                driver: acpRegistry,
                config: { agentId: "devin", commandPath: "/tmp/agent", commandArgs: ["--yolo"] },
              },
            },
          }),
        );

        // Even an unlocked pin wins, and the user's launch values and variables are not used.
        const effective = yield* service.getSettings;
        const claudeInstance = effective.providerInstances[claudeId]!;
        assert.deepEqual(claudeInstance.config, {
          binaryPath: "/opt/claude/bin/claude",
          autoCompactWindow: "300000",
        });
        assert.deepEqual(claudeInstance.environment, [
          { name: "CLAUDE_CODE_USE_BEDROCK", value: "1", sensitive: false },
        ]);
        assert.deepEqual(effective.providerInstances[registryId]?.config, { agentId: "devin" });

        const refused = (instance: typeof claudeInstance) =>
          service
            .updateProviderInstance({ operation: "upsert", instanceId: claudeId, instance })
            .pipe(Effect.flip);
        const launchArgs = yield* refused({
          ...claudeInstance,
          config: { ...claudeInstance.config!, launchArgs: "--permission-mode bypassPermissions" },
        });
        assert.equal(launchArgs.operation, "write-managed-setting");
        assert.equal(launchArgs.managedSetting, "providerInstances.claudeAgent.config.launchArgs");
        const binary = yield* refused({
          ...claudeInstance,
          config: { ...claudeInstance.config!, binaryPath: "/tmp/other-wrapper" },
        });
        assert.equal(binary.managedSetting, "providerInstances.claudeAgent.config.binaryPath");
        const environment = yield* refused({
          ...claudeInstance,
          environment: [{ name: "NODE_OPTIONS", value: "--require /tmp/x.js", sensitive: false }],
        });
        assert.equal(environment.managedSetting, "providerInstances.claudeAgent.environment");
        const commandArgs = yield* service
          .updateProviderInstance({
            operation: "upsert",
            instanceId: registryId,
            instance: {
              driver: acpRegistry,
              config: { agentId: "devin", commandArgs: ["--dangerously-skip-permissions"] },
            },
          })
          .pipe(Effect.flip);
        assert.equal(commandArgs.managedSetting, "providerInstances.acp_devin.config.commandArgs");

        // Unrelated writes carry the stored instance through unchanged, duplicates included.
        yield* service.updateSettings({ defaultAutoPull: true });

        // What the client was shown saves, with user-owned edits, and the stored values survive.
        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: claudeId,
          instance: {
            ...claudeInstance,
            displayName: "Claude (work)",
            config: { ...claudeInstance.config!, autoCompactWindow: "400000" },
          },
        });
        const stored = JSON.parse(yield* fs.readFileString(config.settingsPath));
        assert.deepEqual(stored.providerInstances[claudeId], {
          ...storedClaude,
          displayName: "Claude (work)",
          config: { ...storedClaude.config, autoCompactWindow: "400000" },
        });
      }).pipe(Effect.provide(layerServerSettings(policy))),
    );
  },
);
