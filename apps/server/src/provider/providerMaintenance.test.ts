// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import os from "node:os";
import path from "node:path";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import {
  clearLatestProviderVersionCacheForTests,
  createProviderVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const makeTempDir = Effect.fn("makeTempDir")(function* (name: string) {
  const id = yield* Random.nextUUIDv4;
  return path.join(os.tmpdir(), `${name}-${id}`);
});
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

afterEach(() => {
  clearLatestProviderVersionCacheForTests();
});

describe("providerMaintenance", () => {
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
        const vitePlusBinDir = path.join(tempDir, ".vite-plus", "bin");
        mkdirSync(vitePlusBinDir, { recursive: true });
        const packageToolPath = path.join(vitePlusBinDir, "package-tool");
        writeFileSync(packageToolPath, "#!/bin/sh\n");
        chmodSync(packageToolPath, 0o755);

        expect(
          packageToolUpdate.resolve({
            binaryPath: "package-tool",
            platform: "darwin",
            env: {
              PATH: vitePlusBinDir,
            },
          }),
        ).toEqual({
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
        const bunBinDir = path.join(tempDir, ".bun", "bin");
        mkdirSync(bunBinDir, { recursive: true });
        writeFileSync(path.join(bunBinDir, "native-package-tool.exe"), "MZ");

        expect(
          nativePackageToolUpdate.resolve({
            binaryPath: "native-package-tool",
            platform: "win32",
            env: {
              PATH: bunBinDir,
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ).toEqual({
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
        const pnpmHomeDir = path.join(tempDir, ".local", "share", "pnpm");
        mkdirSync(pnpmHomeDir, { recursive: true });
        const scopedPackageToolPath = path.join(pnpmHomeDir, "scoped-package-tool");
        writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        chmodSync(scopedPackageToolPath, 0o755);

        expect(
          scopedPackageToolUpdate.resolve({
            binaryPath: "scoped-package-tool",
            platform: "darwin",
            env: {
              PATH: pnpmHomeDir,
            },
          }),
        ).toEqual({
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
        platform: "darwin",
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
        const nativeBinDir = path.join(tempDir, ".local", "bin");
        mkdirSync(nativeBinDir, { recursive: true });
        const nativePackageToolPath = path.join(nativeBinDir, "native-package-tool");
        writeFileSync(nativePackageToolPath, "#!/bin/sh\n");
        chmodSync(nativePackageToolPath, 0o755);

        expect(
          nativePackageToolUpdate.resolve({
            binaryPath: "native-package-tool",
            platform: "darwin",
            env: {
              PATH: nativeBinDir,
            },
          }),
        ).toEqual({
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
        const nativeBinDir = path.join(tempDir, ".scoped-package-tool", "bin");
        mkdirSync(nativeBinDir, { recursive: true });
        const scopedPackageToolPath = path.join(nativeBinDir, "scoped-package-tool");
        writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        chmodSync(scopedPackageToolPath, 0o755);

        expect(
          scopedPackageToolUpdate.resolve({
            binaryPath: "scoped-package-tool",
            platform: "darwin",
            env: {
              PATH: nativeBinDir,
            },
          }),
        ).toEqual({
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
        platform: "darwin",
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
        platform: "darwin",
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
      const binDir = path.join(tempDir, "bin");
      const packageBinDir = path.join(
        tempDir,
        "lib",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      mkdirSync(binDir, { recursive: true });
      mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = path.join(packageBinDir, "package-tool.js");
      const symlinkPath = path.join(binDir, "package-tool");
      writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      chmodSync(packageBinPath, 0o755);
      symlinkSync(packageBinPath, symlinkPath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        platform: "darwin",
        env: {
          PATH: "",
        },
      }).pipe(Effect.provide(NodeServices.layer));

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
      const binDir = path.join(tempDir, "bin");
      const packageBinDir = path.join(
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
      mkdirSync(binDir, { recursive: true });
      mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = path.join(packageBinDir, "package-tool.js");
      const symlinkPath = path.join(binDir, "package-tool");
      writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      chmodSync(packageBinPath, 0o755);
      symlinkSync(packageBinPath, symlinkPath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        platform: "darwin",
        env: {
          PATH: "",
        },
      }).pipe(Effect.provide(NodeServices.layer));

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
        platform: "win32",
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
