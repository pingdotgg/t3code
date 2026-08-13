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
  makeProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  normalizeCommandPath,
  ProviderVersionCache,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const writeNodeManagerFixture = (binDir: string, manager: string, globalRoot: string) => {
  const executable = NodePath.join(binDir, manager);
  NodeFS.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${globalRoot}'\n`);
  NodeFS.chmodSync(executable, 0o755);
};
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.map((id) => NodePath.join(NodeOS.tmpdir(), `${name}-${id}`)),
  );
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makeProviderMaintenanceResolver({
  provider: driver("packageTool"),
  packageName: "@example/package-tool",
  homebrewFormula: "package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makeProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  packageName: "@example/native-package-tool",
  homebrewFormula: "native-package-tool",
  nativeUpdate: {
    executable: "native-package-tool",
    args: ["update"],
    lockKey: "native-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
    environment: (executable, environment) => ({
      ...environment,
      PACKAGE_TOOL_INSTALL_DIR: NodePath.dirname(executable),
    }),
  },
});
const scopedPackageToolUpdate = makeProviderMaintenanceResolver({
  provider: driver("scopedPackageTool"),
  packageName: "@example/scoped-package-tool",
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
      {
        ...packageToolUpdate.resolve(),
        latestVersion: "9.9.9",
      },
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
      updateCommand:
        "npm install -g --allow-scripts=@example/native-package-tool @example/native-package-tool@latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("compares abbreviated current versions without treating them as current", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.2",
        latestVersion: "1.3.0",
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "1.2",
      latestVersion: "1.3.0",
    });
  });

  it("compares version components without losing integer precision", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "9007199254740992.0.0",
        latestVersion: "9007199254740993.0.0",
      }),
    ).toMatchObject({ status: "behind_latest" });
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0-9007199254740992",
        latestVersion: "1.0.0-9007199254740993",
      }),
    ).toMatchObject({ status: "behind_latest" });
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

  it.effect("does not trust a vite-plus-shaped path without package ownership metadata", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-vite-plus-capabilities");
      const vitePlusBinDir = NodePath.join(tempDir, ".vite-plus", "bin");
      NodeFS.mkdirSync(vitePlusBinDir, { recursive: true });
      const packageToolPath = NodePath.join(vitePlusBinDir, "package-tool");
      NodeFS.writeFileSync(packageToolPath, "#!/bin/sh\n");
      NodeFS.chmodSync(packageToolPath, 0o755);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: "package-tool",
        env: {
          PATH: vitePlusBinDir,
        },
      }).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

      expect(capabilities).toMatchObject({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        ownershipVerified: false,
        update: null,
      });
    }),
  );

  it.effect("does not trust a Bun-shaped path without package ownership metadata", () =>
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

      expect(capabilities).toMatchObject({
        provider: driver("nativePackageTool"),
        packageName: "@example/native-package-tool",
        ownershipVerified: false,
        update: null,
      });
    }),
  );

  it.effect("does not trust a pnpm-shaped path without package ownership metadata", () =>
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

      expect(capabilities).toMatchObject({
        provider: driver("scopedPackageTool"),
        packageName: "@example/scoped-package-tool",
        ownershipVerified: false,
        update: null,
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

        expect(capabilities).toMatchObject({
          provider: driver("nativePackageTool"),
          packageName: "@example/native-package-tool",
          ownershipVerified: true,
          update: {
            executable: nativePackageToolPath,
            args: ["update"],
            environment: {
              PATH: nativeBinDir,
              PACKAGE_TOOL_INSTALL_DIR: nativeBinDir,
            },
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

        expect(capabilities).toMatchObject({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          ownershipVerified: true,
          update: {
            executable: scopedPackageToolPath,
            args: ["upgrade"],
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

  it.effect(
    "keeps npm updates for binaries symlinked into npm's global node_modules tree",
    (testContext) =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") testContext.skip();
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
        NodeFS.writeFileSync(
          NodePath.join(NodePath.dirname(packageBinDir), "package.json"),
          '{"name":"@example/package-tool","version":"1.0.0"}',
        );
        NodeFS.chmodSync(packageBinPath, 0o755);
        NodeFS.symlinkSync(packageBinPath, symlinkPath);
        writeNodeManagerFixture(binDir, "npm", NodePath.join(tempDir, "lib", "node_modules"));

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: symlinkPath,
            env: {
              PATH: binDir,
            },
          },
        );

        expect(capabilities).toMatchObject({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          installationLabel: "Managed by npm",
          ownershipVerified: true,
          currentVersion: "1.0.0",
          update: {
            command:
              "npm install -g --allow-scripts=@example/package-tool @example/package-tool@latest",

            executable: NodePath.join(binDir, "npm"),

            args: [
              "install",
              "-g",
              "--allow-scripts=@example/package-tool",
              "@example/package-tool@latest",
            ],

            lockKey: `npm:${NodePath.join(tempDir, "lib", "node_modules")}`,
          },
        });
      }),
  );

  it.effect("uses Effect FileSystem realPath when detecting pnpm global symlinks", (testContext) =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") testContext.skip();
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
      NodeFS.writeFileSync(
        NodePath.join(NodePath.dirname(packageBinDir), "package.json"),
        '{"name":"@example/package-tool","version":"1.0.0"}',
      );
      NodeFS.chmodSync(packageBinPath, 0o755);
      NodeFS.symlinkSync(packageBinPath, symlinkPath);
      writeNodeManagerFixture(
        binDir,
        "pnpm",
        NodePath.join(tempDir, ".local", "share", "pnpm", "global", "5", "node_modules"),
      );

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        env: {
          PATH: binDir,
        },
      });

      expect(capabilities).toMatchObject({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        installationLabel: "Managed by pnpm",
        ownershipVerified: true,
        currentVersion: "1.0.0",
        update: {
          command: "pnpm add -g @example/package-tool@latest",

          executable: NodePath.join(binDir, "pnpm"),

          args: ["add", "-g", "@example/package-tool@latest"],

          lockKey: `pnpm:${NodePath.join(
            tempDir,
            ".local",
            "share",
            "pnpm",
            "global",
            "5",
            "node_modules",
          )}`,
        },
      });
    }),
  );

  it("allows the package's own install scripts in npm global updates", () => {
    const claudeUpdate = makeProviderMaintenanceResolver({
      provider: driver("claudeAgent"),
      packageName: "@anthropic-ai/claude-code",
      homebrewFormula: "claude-code",
      nativeUpdate: {
        executable: "claude",
        args: ["update"],
        lockKey: "claude-native",
        isCommandPath: isNativeTestCommandPath("/.local/bin/claude"),
      },
    });

    expect(claudeUpdate.resolve()).toEqual({
      provider: driver("claudeAgent"),
      packageName: "@anthropic-ai/claude-code",
      update: {
        command:
          "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest",

        executable: "npm",

        args: [
          "install",
          "-g",
          "--allow-scripts=@anthropic-ai/claude-code",
          "@anthropic-ai/claude-code@latest",
        ],

        lockKey: "npm-global",
      },
    });
  });

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
