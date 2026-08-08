import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import {
  createBuildConfig,
  shouldResolveMacPasskeySigningConfiguration,
} from "../build-desktop-artifact.ts";
import { TWO_CODE_PRODUCTION_PROFILE } from "./2code-desktop-distribution.ts";

it.effect("builds a legacy-compatible 2code updater configuration", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "mac",
      "dmg",
      "1.0.108",
      true,
      false,
      undefined,
      {
        entitlementsPath: "/tmp/entitlements.2code.mac.plist",
        entitlementsInheritPath: "/tmp/entitlements.2code.mac.plist",
      },
      TWO_CODE_PRODUCTION_PROFILE,
    );

    assert.equal(config.appId, "dev.hafencity.dev.agents");
    assert.equal(config.productName, "2code");
    assert.equal(config.artifactName, "2code-${version}-${arch}.${ext}");
    assert.deepStrictEqual(config.publish, [
      {
        provider: "generic",
        url: "https://pub-cb9e18e7e55d46cf9c297e4b612881f7.r2.dev/releases/desktop",
        updaterCacheDirName: "2code-updater",
      },
    ]);

    const mac = config.mac as Record<string, unknown>;
    assert.equal(mac.executableName, "2code");
    assert.equal(mac.artifactName, "2code-${version}-${arch}-mac.${ext}");
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.gatekeeperAssess, false);
    // Leave notarization enabled so electron-builder staples the app before it
    // derives the ZIP, DMG, blockmaps, and update-manifest hashes.
    assert.equal(mac.notarize, undefined);
    assert.equal(mac.forceCodeSigning, true);
    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.deepStrictEqual(config.dmg, {
      artifactName: "2code-${version}-${arch}.${ext}",
    });
    assert.deepStrictEqual(mac.protocols, [
      {
        name: "2code",
        schemes: ["twentyfirst-agents"],
      },
    ]);
    assert.equal(mac.entitlements, "/tmp/entitlements.2code.mac.plist");
    assert.equal(mac.entitlementsInherit, "/tmp/entitlements.2code.mac.plist");
    assert.notProperty(mac, "provisioningProfile");
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
);

it("does not require the T3 passkey profile for a signed 2code production build", () => {
  assert.isFalse(
    shouldResolveMacPasskeySigningConfiguration("mac", true, TWO_CODE_PRODUCTION_PROFILE),
  );
  assert.isTrue(shouldResolveMacPasskeySigningConfiguration("mac", true, undefined));
  assert.isFalse(shouldResolveMacPasskeySigningConfiguration("mac", false, undefined));
});

it.effect("keeps GitHub update defaults when no fork distribution is selected", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "mac",
      "dmg",
      "0.0.32",
      false,
      false,
      undefined,
      undefined,
    );

    assert.equal(config.appId, "com.t3tools.t3code");
    assert.equal(config.artifactName, "T3-Code-${version}-${arch}.${ext}");
    assert.deepStrictEqual(config.publish, [
      {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "release",
      },
    ]);
    assert.notProperty(config.mac as Record<string, unknown>, "executableName");
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code" },
        }),
      ),
    ),
  ),
);
