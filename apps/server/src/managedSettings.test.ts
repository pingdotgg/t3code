import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ManagedSettings from "./managedSettings.ts";
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

it.layer(NodeServices.layer)("managed settings", (it) => {
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

  it.effect("layers sources by precedence, merging nested objects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-sources-" });
      const lower = path.join(directory, "lower.json");
      const higher = path.join(directory, "higher.json");
      yield* fs.writeFileString(
        lower,
        JSON.stringify({
          enableAgentBrowserAccess: true,
          defaultAutoPull: true,
          providers: { codex: { homePath: "/lower/.codex" } },
        }),
      );
      yield* fs.writeFileString(
        higher,
        JSON.stringify({
          enableAgentBrowserAccess: false,
          providers: { codex: { binaryPath: "/higher/bin/codex" } },
          providerInstances: { codex: { driver: "codex", enabled: false } },
        }),
      );

      const policy = yield* ManagedSettings.loadManagedSettings([
        { kind: "json", path: lower },
        { kind: "json", path: path.join(directory, "missing.json") },
        { kind: "json", path: higher },
      ]);

      assert.deepEqual(policy.document, {
        enableAgentBrowserAccess: false,
        defaultAutoPull: true,
        providers: { codex: { homePath: "/lower/.codex", binaryPath: "/higher/bin/codex" } },
        providerInstances: { codex: { driver: "codex", enabled: false } },
      });
      assert.deepEqual(policy.paths, [
        ["enableAgentBrowserAccess"],
        ["defaultAutoPull"],
        ["providers", "codex", "homePath"],
        ["providers", "codex", "binaryPath"],
        ["providerInstances", "codex", "driver"],
        ["providerInstances", "codex", "enabled"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails instead of enforcing part of an invalid policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-invalid-" });
      const valid = path.join(directory, "valid.json");
      const invalid = path.join(directory, "invalid.json");
      const broken = path.join(directory, "broken.json");
      yield* fs.writeFileString(valid, JSON.stringify({ enableAgentBrowserAccess: false }));
      yield* fs.writeFileString(
        invalid,
        JSON.stringify({
          enableAgentBrowserAccess: false,
          defaultRuntimeMode: "not-a-mode",
          notASetting: true,
          observability: { otlpTracesUrl: "http://corp.test/traces" },
        }),
      );
      yield* fs.writeFileString(broken, "{ not json");

      const invalidError = yield* ManagedSettings.loadManagedSettings([
        { kind: "json", path: valid },
        { kind: "json", path: invalid },
      ]).pipe(Effect.flip);
      assert.equal(invalidError.path, invalid);
      assert.equal(
        invalidError.detail,
        'invalid value for "defaultRuntimeMode", unknown key "notASetting", "observability" cannot be managed',
      );

      const brokenError = yield* ManagedSettings.loadManagedSettings([
        { kind: "json", path: broken },
      ]).pipe(Effect.flip);
      assert.equal(brokenError.path, broken);
      assert.equal(brokenError.detail, "not a JSON object");
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
    "reads a binary MDM plist",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-plist-" });
        const plist = path.join(directory, `${ManagedSettings.MANAGED_PREFERENCES_DOMAIN}.plist`);
        yield* fs.writeFileString(
          plist,
          JSON.stringify({
            enableAgentBrowserAccess: false,
            providers: { codex: { binaryPath: "/mdm/bin/codex" } },
          }),
        );
        // Configuration profiles install binary plists.
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.exitCode(
          ChildProcess.make("/usr/bin/plutil", ["-convert", "binary1", plist], { stdin: "ignore" }),
        );

        const policy = yield* ManagedSettings.loadManagedSettings([{ kind: "plist", path: plist }]);

        assert.deepEqual(policy.document, {
          enableAgentBrowserAccess: false,
          providers: { codex: { binaryPath: "/mdm/bin/codex" } },
        });
      }).pipe(Effect.scoped),
  );
});
