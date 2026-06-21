import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  createStageWorkspaceConfig,
  createStagePnpmConfig,
  createBuildConfig,
  DESKTOP_ASAR_UNPACK,
  renderMacPasskeyEntitlements,
  resolveClerkPasskeyNativeArtifacts,
  resolveMacPasskeySigningConfiguration,
  resolveDesktopRuntimeDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  STAGE_INSTALL_ARGS,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "T3 Code (Alpha)");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "T3 Code (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it.effect("resolves GitHub desktop publish config from Effect config", () =>
    Effect.gen(function* () {
      const latestConfig = yield* resolveGitHubPublishConfig("latest").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );
      const nightlyConfig = yield* resolveGitHubPublishConfig("nightly").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(latestConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "release",
      });
      assert.deepStrictEqual(nightlyConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "prerelease",
        channel: "nightly",
      });
    }),
  );

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "@t3tools/ssh": "workspace:*",
          "@t3tools/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePnpmConfig(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        patchedDependencies: {
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
      },
    );

    assert.equal(
      createStagePnpmConfig(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      undefined,
    );
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod"]);
    assert.deepStrictEqual(createStageWorkspaceConfig("mac", "x64"), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig("win", "arm64"), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["arm64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig("mac", "universal"), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
    });
  });

  it("unpacks the fff shared library for filesystem and FFI access", () => {
    assert.deepStrictEqual(DESKTOP_ASAR_UNPACK, ["node_modules/@ff-labs/fff-bin-*/**/*"]);
  });

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "abc1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "com.t3tools.t3code",
      teamId: "ABC1234567",
      rpDomains: ["example.clerk.accounts.dev"],
      provisioningProfilePath: "/tmp/t3code.provisionprofile",
    });
  });

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS:
        " Clerk.Example.com,example.clerk.accounts.dev,clerk.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration);

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.com.t3tools.t3code</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
  });

  it("rejects incomplete macOS passkey signing configuration", () => {
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          T3CODE_APPLE_TEAM_ID: "ABC1234567",
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
        }),
      /T3CODE_MACOS_PROVISIONING_PROFILE/u,
    );
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          T3CODE_APPLE_TEAM_ID: "ABC1234567",
          T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "https://example.clerk.accounts.dev/path",
        }),
      /Invalid passkey RP domain/u,
    );
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          T3CODE_APPLE_TEAM_ID: "ABC1234567",
          T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
  });

  it.effect("adds passkey entitlements and both renderer protocols to signed macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
        provisioningProfilePath: "/tmp/t3code.provisionprofile",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "com.t3tools.t3code");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.provisioningProfile, "/tmp/t3code.provisionprofile");
      assert.deepStrictEqual(mac.protocols, [
        { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("promotes target fff binaries to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "universal", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("win", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("resolves target Clerk passkey native artifacts", () => {
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("mac", "universal"), [
      {
        packageName: "@clerk/electron-passkeys-darwin-arm64",
        binaryFileName: "electron-passkeys.darwin-arm64.node",
      },
      {
        packageName: "@clerk/electron-passkeys-darwin-x64",
        binaryFileName: "electron-passkeys.darwin-x64.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("win", "x64"), [
      {
        packageName: "@clerk/electron-passkeys-win32-x64-msvc",
        binaryFileName: "electron-passkeys.win32-x64-msvc.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("linux", "x64"), []);
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("resolves default platform and architecture from host references", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: "AMD64",
                  PROCESSOR_ARCHITEW6432: "ARM64",
                },
              }),
            ),
          ),
        ),
      );

      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "arm64");
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
