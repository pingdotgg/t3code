import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import os from "node:os";
import path from "node:path";
import { ProviderDriverKind } from "@t3tools/contracts";
import { Effect } from "effect";
import {
  createProviderVersionAdvisory,
  makePackageManagedProviderVersionLifecycleResolver,
  makeProviderVersionLifecycle,
  makeStaticProviderVersionLifecycleResolver,
  normalizeCommandPath,
  resolveProviderVersionLifecycleEffect,
} from "./providerVersionLifecycle.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makePackageManagedProviderVersionLifecycleResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  homebrewFormula: "package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderVersionLifecycleResolver({
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
const scopedPackageToolUpdate = makePackageManagedProviderVersionLifecycleResolver({
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
const staticToolUpdate = makeStaticProviderVersionLifecycleResolver(
  makeProviderVersionLifecycle({
    provider: driver("staticTool"),
    packageName: null,
    updateExecutable: "static-tool",
    updateArgs: ["update"],
    updateLockKey: "static-tool",
  }),
);

describe("providerVersionLifecycle", () => {
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
        versionLifecycle: nativePackageToolUpdate.resolve(),
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

  it("keeps update commands owned by provider lifecycle metadata", () => {
    expect(staticToolUpdate.resolve()).toEqual({
      provider: driver("staticTool"),
      packageName: null,
      updateCommand: "static-tool update",
      updateExecutable: "static-tool",
      updateArgs: ["update"],
      updateLockKey: "static-tool",
    });
  });

  it("switches package-managed providers to vite-plus updates when the resolved binary lives in vite-plus global bin", () => {
    const tempDir = path.join(os.tmpdir(), `t3-vite-plus-lifecycle-${Date.now()}`);
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
      updateCommand: "vp i -g @example/package-tool",
      updateExecutable: "vp",
      updateArgs: ["i", "-g", "@example/package-tool"],
      updateLockKey: "vite-plus-global",
    });
  });

  it("switches package-managed providers to bun updates when the resolved binary lives in bun's global bin", () => {
    const tempDir = path.join(os.tmpdir(), `t3-bun-lifecycle-${Date.now()}`);
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
      updateCommand: "bun i -g @example/native-package-tool@latest",
      updateExecutable: "bun",
      updateArgs: ["i", "-g", "@example/native-package-tool@latest"],
      updateLockKey: "bun-global",
    });
  });

  it("switches package-managed providers to pnpm updates when the resolved binary lives in pnpm's global bin", () => {
    const tempDir = path.join(os.tmpdir(), `t3-pnpm-lifecycle-${Date.now()}`);
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
      updateCommand: "pnpm add -g @example/scoped-package-tool@latest",
      updateExecutable: "pnpm",
      updateArgs: ["add", "-g", "@example/scoped-package-tool@latest"],
      updateLockKey: "pnpm-global",
    });
  });

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
      updateCommand: "brew upgrade package-tool",
      updateExecutable: "brew",
      updateArgs: ["upgrade", "package-tool"],
      updateLockKey: "homebrew",
    });
  });

  it("switches native-package-tool to native updates when the binary resolves through the native installer", () => {
    const tempDir = path.join(os.tmpdir(), `t3-native-package-tool-native-lifecycle-${Date.now()}`);
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
      updateCommand: "native-package-tool update",
      updateExecutable: "native-package-tool",
      updateArgs: ["update"],
      updateLockKey: "native-package-tool-native",
    });
  });

  it("switches scoped-package-tool to native upgrades when the binary resolves through the standalone installer", () => {
    const tempDir = path.join(os.tmpdir(), `t3-scoped-package-tool-native-lifecycle-${Date.now()}`);
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
      updateCommand: "scoped-package-tool upgrade",
      updateExecutable: "scoped-package-tool",
      updateArgs: ["upgrade"],
      updateLockKey: "scoped-package-tool-native",
    });
  });

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
      updateCommand: "brew upgrade native-package-tool",
      updateExecutable: "brew",
      updateArgs: ["upgrade", "native-package-tool"],
      updateLockKey: "homebrew",
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
      updateCommand: "brew upgrade example/tap/scoped-package-tool",
      updateExecutable: "brew",
      updateArgs: ["upgrade", "example/tap/scoped-package-tool"],
      updateLockKey: "homebrew",
    });
  });

  it("keeps npm updates for binaries symlinked into npm's global node_modules tree", async () => {
    const tempDir = path.join(os.tmpdir(), `t3-npm-lifecycle-${Date.now()}`);
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

    await expect(
      Effect.runPromise(
        resolveProviderVersionLifecycleEffect(packageToolUpdate, {
          binaryPath: symlinkPath,
          platform: "darwin",
          env: {
            PATH: "",
          },
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).resolves.toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateCommand: "npm install -g @example/package-tool@latest",
      updateExecutable: "npm",
      updateArgs: ["install", "-g", "@example/package-tool@latest"],
      updateLockKey: "npm-global",
    });
  });

  it("uses Effect FileSystem realPath when detecting pnpm global symlinks", async () => {
    const tempDir = path.join(os.tmpdir(), `t3-pnpm-realpath-lifecycle-${Date.now()}`);
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

    await expect(
      Effect.runPromise(
        resolveProviderVersionLifecycleEffect(packageToolUpdate, {
          binaryPath: symlinkPath,
          platform: "darwin",
          env: {
            PATH: "",
          },
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).resolves.toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateCommand: "pnpm add -g @example/package-tool@latest",
      updateExecutable: "pnpm",
      updateArgs: ["add", "-g", "@example/package-tool@latest"],
      updateLockKey: "pnpm-global",
    });
  });

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
      updateCommand: null,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: null,
    });
  });
});
