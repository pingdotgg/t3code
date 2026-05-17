import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { AcpRegistryInstallState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

import {
  getInstallState,
  InstallManifestError,
  readInstalls,
  setInstallState,
  writeInstalls,
} from "./installManifest.ts";

const npxInstall = {
  version: "1.0.0",
  installedAt: "2026-05-17T00:00:00.000Z",
  distribution: "npx",
} satisfies AcpRegistryInstallState;

const binaryInstall = {
  version: "2.0.0",
  installedAt: "2026-05-17T01:00:00.000Z",
  distribution: "binary",
  binaryPath: "/tmp/acp-agent",
  authMethods: [{ id: "oauth", name: "OAuth", description: "OAuth login" }],
} satisfies AcpRegistryInstallState;

const makeLayer = () =>
  ServerSettings.layerTest().pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-install-manifest-test-",
        }),
      ),
    ),
  );

const manifestPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return `${config.acpRegistryCacheDir}/installs.json`;
});

it.layer(NodeServices.layer)("installManifest", (it) => {
  it.effect("returns an empty manifest when no manifest or legacy settings exist", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* readInstalls, {});
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("migrates legacy settings installs into the manifest on first read", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      yield* settings.updateSettings({
        acpRegistryInstalls: {
          "legacy-agent": npxInstall,
        },
      });

      assert.deepEqual(yield* readInstalls, {
        "legacy-agent": npxInstall,
      });
      assert.isTrue(yield* fs.exists(yield* manifestPath));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("prefers the manifest over legacy settings when both exist", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* writeInstalls({
        "manifest-agent": binaryInstall,
      });
      yield* settings.updateSettings({
        acpRegistryInstalls: {
          "settings-agent": npxInstall,
        },
      });

      assert.deepEqual(yield* readInstalls, {
        "manifest-agent": binaryInstall,
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("writes install updates to the manifest without mutating settings", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* writeInstalls({
        "manifest-agent": npxInstall,
      });

      assert.deepEqual((yield* settings.getSettings).acpRegistryInstalls, {});
      assert.deepEqual(yield* getInstallState("manifest-agent"), npxInstall);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("removes a single install from the manifest", () =>
    Effect.gen(function* () {
      yield* setInstallState("agent-a", npxInstall);
      yield* setInstallState("agent-b", binaryInstall);
      yield* setInstallState("agent-a", null);

      assert.deepEqual(yield* readInstalls, {
        "agent-b": binaryInstall,
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("fails clearly when the manifest is corrupt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        yield* manifestPath,
        `{"broken-agent":{"version":"","installedAt":"2026-05-17T00:00:00.000Z","distribution":"npx"}}`,
      );

      const error = yield* Effect.flip(readInstalls);
      assert.instanceOf(error, InstallManifestError);
      assert.equal(error.detail, "Invalid install manifest");
    }).pipe(Effect.provide(makeLayer())),
  );
});
