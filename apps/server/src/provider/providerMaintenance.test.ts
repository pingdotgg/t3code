// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  normalizeCommandPath,
  ProviderVersionCache,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.map((id) => NodePath.join(NodeOS.tmpdir(), `${name}-${id}`)),
  );
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  homebrewFormula: "package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  homebrewFormula: "native-package-tool",
  nativeUpdate: {
    executable: "native-package-tool",
    args: ["update"],
    lockKey: "native-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
const scopedPackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("scopedPackageTool"),
  npmPackageName: "@example/scoped-package-tool",
  homebrewFormula: "example/tap/scoped-package-tool",
  nativeUpdate: {
    executable: "scoped-package-tool",
    args: ["upgrade"],
    lockKey: "scoped-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.scoped-package-tool/bin/scoped-package-tool"),
  },
});
const staticToolUpdate = makeStaticProviderMaintenanceResolver(
  makeProviderMaintenanceCapabilities({
    provider: driver("staticTool"),
    packageName: null,
    updateExecutable: "static-tool",
    updateArgs: ["update"],
    updateLockKey: "static-tool",
  }),
);
const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("packageTool"),
  driver: driver("packageTool"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

it.layer(NodeServices.layer)("providerMaintenance", (it) => {
  it.effect("reads cached versions through the injectable cache reference", () =>
    resolveLatestProviderVersion(packageToolUpdate.resolve()).pipe(
      Effect.provideService(
        ProviderVersionCache,
        new Map([
          [
            "@example/package-tool",
            {
              expiresAt: Number.MAX_SAFE_INTEGER,
              version: "9.9.9",
            },
          ],
        ]),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("cached provider version should not make an HTTP request"),
        ),
      ),
      Effect.map((version) => {
        expect(version).toBe("9.9.9");
      }),
    ),
  );

  it.effect("does not fetch latest provider versions when update checks are disabled", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      installedPackageToolProvider,
      packageToolUpdate.resolve(),
      {
        enableProviderUpdateChecks: false,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("disabled provider update checks should not make an HTTP request"),
        ),
      ),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "unknown",
          currentVersion: "1.0.0",
          latestVersion: null,
          checkedAt: "2026-04-10T00:00:00.000Z",
        });
      }),
    ),
  );

  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it("marks installed providers behind latest when a newer provider version is available", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("nativePackageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: nativePackageToolUpdate.resolve(),
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "2.1.110",
      latestVersion: "2.1.117",
      updateCommand: "npm install -g @example/native-package-tool@latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("keeps update commands owned by provider maintenance capabilities", () => {
    expect(staticToolUpdate.resolve()).toEqual({
      provider: driver("staticTool"),
      packageName: null,
      update: {
        command: "static-tool update",

        executable: "static-tool",

        args: ["update"],

        lockKey: "static-tool",
      },
    });
  });

  it.effect(
    "switches package-managed providers to vite-plus updates when the resolved binary lives in vite-plus global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-vite-plus-capabilities");
        const vitePlusBinDir = NodePath.join(tempDir, ".vite-plus", "bin");
        NodeFS.mkdirSync(vitePlusBinDir, { recursive: true });
        const packageToolPath = NodePath.join(vitePlusBinDir, "package-tool");
        NodeFS.writeFileSync(packageToolPath, "#!/bin/sh\n");
        NodeFS.chmodSync(packageToolPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: "package-tool",
            env: {
              PATH: vitePlusBinDir,
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          update: {
            command: "vp i -g @example/package-tool",

            executable: "vp",

            args: ["i", "-g", "@example/package-tool"],

            lockKey: "vite-plus-global",
          },
        });
      }),
  );

  it.effect(
    "switches package-managed providers to bun updates when the resolved binary lives in bun's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-bun-capabilities");
        const bunBinDir = NodePath.join(tempDir, ".bun", "bin");
        NodeFS.mkdirSync(bunBinDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(bunBinDir, "native-package-tool.exe"), "MZ");

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          {
            binaryPath: "native-package-tool",
            env: {
              PATH: bunBinDir,
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "win32"));

        expect(capabilities).toEqual({
          provider: driver("nativePackageTool"),
          packageName: "@example/native-package-tool",
          update: {
            command: "bun i -g @example/native-package-tool@latest",

            executable: "bun",

            args: ["i", "-g", "@example/native-package-tool@latest"],

            lockKey: "bun-global",
          },
        });
      }),
  );

  it.effect(
    "switches package-managed providers to pnpm updates when the resolved binary lives in pnpm's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-capabilities");
        const pnpmHomeDir = NodePath.join(tempDir, ".local", "share", "pnpm");
        NodeFS.mkdirSync(pnpmHomeDir, { recursive: true });
        const scopedPackageToolPath = NodePath.join(pnpmHomeDir, "scoped-package-tool");
        NodeFS.writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        NodeFS.chmodSync(scopedPackageToolPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          scopedPackageToolUpdate,
          {
            binaryPath: "scoped-package-tool",
            env: {
              PATH: pnpmHomeDir,
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          update: {
            command: "pnpm add -g @example/scoped-package-tool@latest",

            executable: "pnpm",

            args: ["add", "-g", "@example/scoped-package-tool@latest"],

            lockKey: "pnpm-global",
          },
        });
      }),
  );

  it("switches package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/package-tool",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: {
        command: "brew upgrade package-tool",

        executable: "brew",

        args: ["upgrade", "package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it.effect(
    "switches native-package-tool to native updates when the binary resolves through the native installer",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-native-package-tool-native-capabilities");
        const nativeBinDir = NodePath.join(tempDir, ".local", "bin");
        NodeFS.mkdirSync(nativeBinDir, { recursive: true });
        const nativePackageToolPath = NodePath.join(nativeBinDir, "native-package-tool");
        NodeFS.writeFileSync(nativePackageToolPath, "#!/bin/sh\n");
        NodeFS.chmodSync(nativePackageToolPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          {
            binaryPath: "native-package-tool",
            env: {
              PATH: nativeBinDir,
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: driver("nativePackageTool"),
          packageName: "@example/native-package-tool",
          update: {
            command: "native-package-tool update",

            executable: "native-package-tool",

            args: ["update"],

            lockKey: "native-package-tool-native",
          },
        });
      }),
  );

  it.effect(
    "switches scoped-package-tool to native upgrades when the binary resolves through the standalone installer",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-scoped-package-tool-native-capabilities");
        const nativeBinDir = NodePath.join(tempDir, ".scoped-package-tool", "bin");
        NodeFS.mkdirSync(nativeBinDir, { recursive: true });
        const scopedPackageToolPath = NodePath.join(nativeBinDir, "scoped-package-tool");
        NodeFS.writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        NodeFS.chmodSync(scopedPackageToolPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          scopedPackageToolUpdate,
          {
            binaryPath: "scoped-package-tool",
            env: {
              PATH: nativeBinDir,
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          update: {
            command: "scoped-package-tool upgrade",

            executable: "scoped-package-tool",

            args: ["upgrade"],

            lockKey: "scoped-package-tool-native",
          },
        });
      }),
  );

  it("switches native-package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      nativePackageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/native-package-tool",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("nativePackageTool"),
      packageName: "@example/native-package-tool",
      update: {
        command: "brew upgrade native-package-tool",

        executable: "brew",

        args: ["upgrade", "native-package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it("switches scoped-package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      scopedPackageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/scoped-package-tool",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("scopedPackageTool"),
      packageName: "@example/scoped-package-tool",
      update: {
        command: "brew upgrade example/tap/scoped-package-tool",

        executable: "brew",

        args: ["upgrade", "example/tap/scoped-package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it.effect("keeps npm updates for binaries symlinked into npm's global node_modules tree", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-capabilities");
      const binDir = NodePath.join(tempDir, "bin");
      const packageBinDir = NodePath.join(
        tempDir,
        "lib",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = NodePath.join(packageBinDir, "package-tool.js");
      const symlinkPath = NodePath.join(binDir, "package-tool");
      NodeFS.writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      NodeFS.chmodSync(packageBinPath, 0o755);
      NodeFS.symlinkSync(packageBinPath, symlinkPath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        env: {
          PATH: "",
        },
      });

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command: "npm install -g @example/package-tool@latest",

          executable: "npm",

          args: ["install", "-g", "@example/package-tool@latest"],

          lockKey: "npm-global",
        },
      });
    }),
  );

  it.effect("uses Effect FileSystem realPath when detecting pnpm global symlinks", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-pnpm-realpath-capabilities");
      const binDir = NodePath.join(tempDir, "bin");
      const packageBinDir = NodePath.join(
        tempDir,
        ".local",
        "share",
        "pnpm",
        "global",
        "5",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = NodePath.join(packageBinDir, "package-tool.js");
      const symlinkPath = NodePath.join(binDir, "package-tool");
      NodeFS.writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      NodeFS.chmodSync(packageBinPath, 0o755);
      NodeFS.symlinkSync(packageBinPath, symlinkPath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        env: {
          PATH: "",
        },
      });

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command: "pnpm add -g @example/package-tool@latest",

          executable: "pnpm",

          args: ["add", "-g", "@example/package-tool@latest"],

          lockKey: "pnpm-global",
        },
      });
    }),
  );

  it("disables one-click updates for explicit custom binary paths it cannot safely map", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "C:\\Tools\\package-tool\\package-tool.exe",
        env: {
          PATH: "",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: null,
    });
  });
});
