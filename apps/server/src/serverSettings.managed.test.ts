import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as ManagedSettings from "@t3tools/shared/managedSettings";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const layerServerSettings = (managedDocument: Record<string, unknown>) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedSettings.layerTest(managedDocument)),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-managed-settings-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("server settings under managed policy", (it) => {
  it.effect("enforces managed values without writing them into the user's settings", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          enableAgentBrowserAccess: true,
          providers: { codex: { binaryPath: "/user/bin/codex", homePath: "/user/.codex" } },
          projectSettingsOverrides: {
            app: { enableAgentBrowserAccess: true, responseStreamingMode: "turn" },
          },
        }),
      );

      const settings = yield* service.getSettings;
      assert.isFalse(settings.enableAgentBrowserAccess);
      // Objects merge by key: the policy pins one path and leaves the other.
      assert.equal(settings.providers.codex.binaryPath, "/corp/bin/codex");
      assert.equal(settings.providers.codex.homePath, "/user/.codex");
      // A project override cannot opt out of a managed key.
      assert.deepEqual(settings.projectSettingsOverrides, {
        [ProjectId.make("app")]: { responseStreamingMode: "turn" },
      });

      const updated = yield* service.updateSettings({
        enableAgentBrowserAccess: true,
        addProjectBaseDirectory: "~/Code",
      });
      assert.isFalse(updated.enableAgentBrowserAccess);
      assert.equal(updated.addProjectBaseDirectory, "~/Code");

      // Lifting the policy hands back the user's own values.
      const persisted = JSON.parse(yield* fs.readFileString(config.settingsPath));
      assert.isUndefined(persisted.enableAgentBrowserAccess);
      assert.equal(persisted.providers.codex.binaryPath, "/user/bin/codex");
      assert.isTrue(persisted.projectSettingsOverrides.app.enableAgentBrowserAccess);
      assert.equal(persisted.addProjectBaseDirectory, "~/Code");
    }).pipe(
      Effect.provide(
        layerServerSettings({
          enableAgentBrowserAccess: false,
          providers: { codex: { binaryPath: "/corp/bin/codex" } },
        }),
      ),
    ),
  );

  it.effect("merges a managed provider instance into the user's legacy provider config", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          providers: { codex: { binaryPath: "/user/bin/codex", homePath: "/user/.codex" } },
        }),
      );

      const settings = yield* service.getSettings;
      const codex = settings.providerInstances[ProviderInstanceId.make("codex")];
      assert.isFalse(codex?.enabled);
      assert.deepInclude(codex?.config as Record<string, unknown>, {
        binaryPath: "/corp/bin/codex",
        homePath: "/user/.codex",
      });
    }).pipe(
      Effect.provide(
        layerServerSettings({
          providerInstances: {
            codex: { driver: "codex", enabled: false, config: { binaryPath: "/corp/bin/codex" } },
          },
        }),
      ),
    ),
  );
});
