// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
import {
  createProviderVersionAdvisory,
  makeTargetedProviderUpdateAction,
  enrichProviderSnapshotWithVersionAdvisory,
  homebrewOwnershipFromCommandPath,
  invalidateLatestProviderVersion,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  npmGlobalPrefixFromCommandPath,
  parseChocolateyLatestVersion,
  parseHomebrewLatestVersion,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type PackageManagedProviderMaintenanceDefinition,
  type ProviderMaintenanceCapabilities,
} from "./maintenanceResolver.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { driver, installedPackageToolProvider, isNativeTestCommandPath, linkIntoPackage, makeTempDir, manualPackageTool, nativePackageToolUpdate, noSpawn, packageToolUpdate, stdoutSpawner, windowsHost, writeExecutable } from "./maintenanceResolver.helpers2.testkit.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(HostProcess.Environment, { PATH: "" }),
  ),
)("providerMaintenance", (it) => {

  it.effect.skipIf(!symlinksSupported)(
    "switches to pnpm updates when the real path lives in pnpm's global store",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-capabilities");
        const link = linkIntoPackage(tempDir, "package-tool", [
          ".local",
          "share",
          "pnpm",
          "global",
          "5",
          "node_modules",
          "@example",
          "package-tool",
        ]);

        const updateCommand = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
          resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
            binaryPath: link,
            env: { PATH: "" },
          }).pipe(
            Effect.map((capabilities) => capabilities.update),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
        const pnpmVersion = (version: string) =>
          stdoutSpawner((command, args) => {
            expect([command, ...args].join(" ")).toMatch(/pnpm(\.cmd)?"? --version$/);
            return `${version}
`;
          });

        expect(yield* updateCommand(pnpmVersion("11.1.3"))).toMatchObject({
          command: "pnpm add -g --allow-build=@example/package-tool @example/package-tool@latest",
          lockKey: "pnpm-global",
        });
        expect((yield* updateCommand(pnpmVersion("10.3.0")))?.command).toBe(
          "pnpm add -g @example/package-tool@latest",
        );
        expect((yield* updateCommand(noSpawn))?.command).toBe(
          "pnpm add -g @example/package-tool@latest",
        );
      }),
  );

  it.effect.each([
    {
      case: "the eligible release with an inherited PATH",
      inheritPath: true,
      outdated: { "@example/package-tool": { current: "1.0.0", latest: "1.1.0" } },
      exitCode: 1,
      npmOutput: '"1.2.0"',
      expected: "1.1.0",
    },
    {
      case: "no update during cooldown",
      outdated: {},
      exitCode: 0,
      npmOutput: '"1.2.0"',
      expected: "1.0.0",
    },
    {
      case: "the public registry fallback when pnpm fails and npm is unavailable",
      outdated: { "@example/package-tool": { current: "1.0.0", latest: "1.1.0" } },
      exitCode: 2,
      expected: "9.9.9",
    },
    {
      case: "the configured npm registry when the pnpm probe fails",
      outdated: {},
      exitCode: 2,
      npmOutput: '"1.2.0"',
      expected: "1.2.0",
    },
    {
      case: "an unknown version when both configured lookups fail",
      outdated: {},
      exitCode: 2,
      npmOutput: "not json",
      expected: null,
    },
  ])(
    "advertises $case for pnpm-global installs",
    (fixture) =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-latest");
        const pnpmBinDir = NodePath.join(tempDir, "pnpm-bin");
        writeExecutable(NodePath.join(pnpmBinDir, "pnpm"));
        if (fixture.npmOutput !== undefined) writeExecutable(NodePath.join(pnpmBinDir, "npm"));
        const link = linkIntoPackage(tempDir, "package-tool", [
          ".local",
          "share",
          "pnpm",
          "global",
          "5",
          "node_modules",
          "@example",
          "package-tool",
        ]);

        let npmProbes = 0;
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          { binaryPath: link, env: fixture.inheritPath ? {} : { PATH: pnpmBinDir } },
        ).pipe(
          Effect.provideService(HostProcess.Environment, {
            PATH: fixture.inheritPath ? pnpmBinDir : "",
          }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner(
              (_command, args) => {
                if (args[0] === "view") {
                  npmProbes++;
                  return fixture.npmOutput ?? "";
                }
                return args[0] === "outdated"
                  ? JSON.stringify(fixture.outdated)
                  : JSON.stringify([
                      { dependencies: { "@example/package-tool": { version: "1.0.0" } } },
                    ]);
              },
              (args) => (args[0] === "outdated" ? fixture.exitCode : 0),
            ),
          ),
        );

        const provider = yield* enrichProviderSnapshotWithVersionAdvisory(
          installedPackageToolProvider,
          capabilities,
        ).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([["@example/package-tool", "9.9.9"]]),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("the npm version is already cached")),
          ),
        );
        expect(provider.versionAdvisory).toMatchObject({
          status:
            fixture.expected === null
              ? "unknown"
              : fixture.expected === "1.0.0"
                ? "current"
                : "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: fixture.expected,
        });
        expect(npmProbes).toBe(fixture.exitCode === 2 && fixture.npmOutput !== undefined ? 1 : 0);
      }),
    { skip: !symlinksSupported || windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "switches to bun updates when the resolved binary lives in bun's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-bun-capabilities");
        const bunBinDir = NodePath.join(tempDir, ".bun", "bin");
        writeExecutable(NodePath.join(bunBinDir, "package-tool"));

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: "package-tool",
            env: { PATH: bunBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        );

        expect(capabilities.update).toMatchObject({
          command: "bun i -g @example/package-tool@latest",
          lockKey: "bun-global",
        });
      }),
  );

  it.effect.skipIf(windowsHost)("switches to native updates and runs the resolved executable", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-capabilities");
      const nativeBinDir = NodePath.join(tempDir, ".local", "bin");
      const nativePath = NodePath.join(nativeBinDir, "native-package-tool");
      writeExecutable(nativePath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        nativePackageToolUpdate,
        {
          binaryPath: "native-package-tool",
          env: { PATH: nativeBinDir },
        },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );

      expect(capabilities).toEqual({
        provider: driver("nativePackageTool"),
        packageName: "@example/native-package-tool",
        update: {
          command: `${nativePath} update`,
          executable: nativePath,
          args: ["update"],
          lockKey: "nativePackageTool-native",
        },
      });
    }),
  );

  it.effect.each(["wrapper", "symlink"])(
    "keeps a mise-owned %s in a native install location manual-only",
    (launcher, { skip }) => {
      if (windowsHost || (launcher === "symlink" && !symlinksSupported)) skip();
      return Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-native-mise");
        const nativePath = NodePath.join(tempDir, ".local", "bin", "native-package-tool");
        if (launcher === "wrapper") {
          writeExecutable(nativePath);
          NodeFS.writeFileSync(
            nativePath,
            '#!/bin/sh\nexec mise x native-package-tool -- native-package-tool "$@"\n',
          );
        } else {
          const target = NodePath.join(
            tempDir,
            "mise",
            "installs",
            "native-package-tool",
            "1.0.0",
            "native-package-tool",
          );
          writeExecutable(target);
          NodeFS.mkdirSync(NodePath.dirname(nativePath), { recursive: true });
          NodeFS.symlinkSync(target, nativePath);
        }

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          { binaryPath: nativePath, env: { PATH: "" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toBeNull();
      });
    },
  );

  it.effect.skipIf(!symlinksSupported || windowsHost)(
    "updates an npm-owned launcher in a native install location with npm",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-native-npm");
        const prefix = NodePath.join(tempDir, ".local");
        const packageBin = NodePath.join("node_modules", "@example", "native-package-tool", "bin");
        writeExecutable(NodePath.join(prefix, "lib", packageBin, "native-package-tool.exe"));
        const launcher = NodePath.join(prefix, "bin", "native-package-tool");
        NodeFS.mkdirSync(NodePath.dirname(launcher), { recursive: true });
        NodeFS.symlinkSync(
          NodePath.join("..", "lib", packageBin, "native-package-tool.exe"),
          launcher,
        );

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          { binaryPath: launcher, env: { PATH: "" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toMatchObject({
          executable: "npm",
          args: expect.arrayContaining(["--prefix", prefix]),
          lockKey: `npm-global:${normalizeCommandPath(prefix)}`,
        });
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "prefers npm ownership over the Node keg the package lives under",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-homebrew-node-capabilities");
        const keg = NodePath.join(tempDir, "Cellar", "node", "22.1.0");
        const target = NodePath.join(
          keg,
          "lib",
          "node_modules",
          "@example",
          "package-tool",
          "bin",
          "package-tool.js",
        );
        writeExecutable(target);
        const link = NodePath.join(tempDir, "bin", "package-tool");
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
        NodeFS.symlinkSync(target, link);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toMatchObject({
          executable: "npm",
          args: expect.arrayContaining(["--prefix", keg]),
          lockKey: `npm-global:${normalizeCommandPath(keg)}`,
        });
      }),
  );

  it("quotes copyable command words the shell would split", () => {
    const posix = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateExecutable: "npm",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        "/Users/Jane Doe/.npm-global",
        "@example/package-tool@latest",
      ],
      updateLockKey: "npm-global",
      platform: "darwin",
    });
    expect(posix.update?.command).toBe(
      "npm install -g --prefix '/Users/Jane Doe/.npm-global' @example/package-tool@latest",
    );
    const windows = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: null,
      updateExecutable: "C:\\Program Files\\Tool\\tool.exe",
      updateArgs: ["update"],
      updateLockKey: "tool",
      platform: "win32",
    });
    expect(windows.update?.command).toBe("& 'C:\\Program Files\\Tool\\tool.exe' update");
  });

  it.effect.skipIf(windowsHost)("carries the native updater's environment into the action", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-env");
      const nativePath = NodePath.join(tempDir, ".local", "bin", "native-package-tool");
      writeExecutable(nativePath);
      const resolver = makePackageManagedProviderMaintenanceResolver({
        provider: driver("nativePackageTool"),
        npmPackageName: "@example/native-package-tool",
        nativeUpdate: {
          args: ["update"],
          isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
          env: { TOOL_HOME: tempDir },
        },
      });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(resolver, {
        binaryPath: nativePath,
        env: { PATH: "" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update?.env).toEqual({ TOOL_HOME: tempDir });
    }),
  );

  it("reads the Chocolatey package version from choco search --limit-output", () => {
    expect(parseChocolateyLatestVersion("claude-code|2.1.304\r\n", "claude-code")).toBe("2.1.304");
    expect(parseChocolateyLatestVersion("Claude-Code|2.1.304\r\n", "claude-code")).toBe("2.1.304");
    expect(parseChocolateyLatestVersion("claude-code-other|9.9.9\r\n", "claude-code")).toBeNull();
    expect(parseChocolateyLatestVersion("", "claude-code")).toBeNull();
  });

  it("recognizes Homebrew kegs and casks from the real executable path", () => {
    expect(
      homebrewOwnershipFromCommandPath("/opt/homebrew/Cellar/claude-code@latest/2.1.0/bin/claude"),
    ).toEqual({ kind: "formula", name: "claude-code@latest", prefix: "/opt/homebrew" });
    expect(homebrewOwnershipFromCommandPath("/usr/local/Caskroom/codex/0.148.0/codex")).toEqual({
      kind: "cask",
      name: "codex",
      prefix: "/usr/local",
    });
    expect(homebrewOwnershipFromCommandPath("/usr/local/bin/codex")).toBeNull();
    expect(homebrewOwnershipFromCommandPath("/srv/Cellar/claude/1.0.0/bin/claude")).toMatchObject({
      prefix: "/srv",
    });
  });

  it.effect("shares installer lookups only for the same executable and update target", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const capabilities = (executable: string, args: ReadonlyArray<string>, version: string) =>
        makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: executable,
          updateArgs: args,
          updateLockKey: "homebrew",
          latestVersion: null,
          lookupLatestVersion: Effect.sync(() => {
            lookups += 1;
            return version;
          }),
        });

      const formula = capabilities("/opt/homebrew/bin/brew", ["upgrade", "package-tool"], "2.0.0");
      const cask = capabilities(
        "/opt/homebrew/bin/brew",
        ["upgrade", "--cask", "package-tool"],
        "3.0.0",
      );
      const otherBrew = capabilities("/usr/local/bin/brew", ["upgrade", "package-tool"], "4.0.0");

      expect(yield* resolveLatestProviderVersion(formula)).toBe("2.0.0");
      expect(yield* resolveLatestProviderVersion(cask)).toBe("3.0.0");
      expect(yield* resolveLatestProviderVersion(otherBrew)).toBe("4.0.0");
      const refreshed = capabilities(
        "/opt/homebrew/bin/brew",
        ["upgrade", "package-tool"],
        "5.0.0",
      );
      expect(yield* resolveLatestProviderVersion(refreshed)).toBe("2.0.0");
      expect(lookups).toBe(3);

      yield* invalidateLatestProviderVersion(refreshed);
      expect(yield* resolveLatestProviderVersion(refreshed)).toBe("5.0.0");
      expect(yield* resolveLatestProviderVersion(cask)).toBe("3.0.0");
      expect(yield* resolveLatestProviderVersion(otherBrew)).toBe("4.0.0");
      expect(lookups).toBe(4);
    }).pipe(
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Homebrew's latest should not come from npm")),
      ),
    ),
  );

  it.effect(
    "refreshes installer versions without letting an older lookup overwrite the result",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<string>();
        let lookups = 0;
        const capabilities = makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: "/opt/homebrew/bin/brew",
          updateArgs: ["upgrade", "package-tool"],
          updateLockKey: "homebrew",
          latestVersion: null,
          lookupLatestVersion: Effect.suspend(() =>
            ++lookups === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.succeed("2.0.0"),
          ),
        });
        const pending = yield* resolveLatestProviderVersion(capabilities).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* invalidateLatestProviderVersion(capabilities);
        expect(yield* resolveLatestProviderVersion(capabilities)).toBe("2.0.0");

        yield* Deferred.succeed(release, "1.0.0");
        expect(yield* Fiber.join(pending)).toBe("1.0.0");
        expect(yield* resolveLatestProviderVersion(capabilities)).toBe("2.0.0");
        expect(lookups).toBe(2);
      }).pipe(
        Effect.provide(ProviderLatestVersions.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Homebrew's latest should not come from npm")),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)(
    "stays manual-only when the keg is not under the resolved brew's prefix",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-homebrew-foreign-prefix");
        const brewBinDir = NodePath.join(tempDir, "brew-bin");
        writeExecutable(NodePath.join(brewBinDir, "brew"));
        const kegBinary = NodePath.join(
          tempDir,
          "elsewhere",
          "Cellar",
          "package-tool",
          "1.0.0",
          "bin",
          "package-tool",
        );
        writeExecutable(kegBinary);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: kegBinary,
            env: { PATH: brewBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner(() => "/opt/homebrew\n"),
          ),
        );

        expect(capabilities).toEqual({
          ...manualPackageTool,
          installPath: NodeFS.realpathSync(kegBinary),
        });
      }),
  );

  it("reads the stable formula version from brew info", () => {
    const info = JSON.stringify({ formulae: [{ versions: { stable: "2.1.5" } }] });
    const formula = { kind: "formula", name: "claude-code", prefix: "/opt/homebrew" } as const;
    expect(parseHomebrewLatestVersion(info, formula)).toBe("2.1.5");
    expect(parseHomebrewLatestVersion("not json", formula)).toBeNull();
  });

  it("treats Homebrew's latest cask version as unknown", () => {
    const info = JSON.stringify({ casks: [{ version: "latest" }] });
    const cask = { kind: "cask", name: "package-tool", prefix: "/opt/homebrew" } as const;
    expect(parseHomebrewLatestVersion(info, cask)).toBeNull();
  });

  it.effect.skipIf(windowsHost)(
    "disables one-click updates for explicit custom binary paths it cannot safely map",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-custom-capabilities");
        const customPath = NodePath.join(tempDir, "tools", "package-tool");
        writeExecutable(customPath);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: customPath,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities).toEqual({
          ...manualPackageTool,
          installPath: NodeFS.realpathSync(customPath),
        });
      }),
  );

  it.effect.skipIf(windowsHost)(
    "falls back to the provider's own updater when no installer is proven",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-self-update-fallback");
        const customPath = NodePath.join(tempDir, "tools", "package-tool");
        writeExecutable(customPath);
        const selfUpdating = makePackageManagedProviderMaintenanceResolver({
          provider: driver("packageTool"),
          npmPackageName: "@example/package-tool",
          nativeUpdate: { args: ["update", "--self"] },
        });

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(selfUpdating, {
          binaryPath: customPath,
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        expect(capabilities.update).toMatchObject({
          executable: customPath,
          args: ["update", "--self"],
          lockKey: "packageTool-native",
        });

        const misePath = NodePath.join(tempDir, "mise", "installs", "package-tool", "1.0.0", "bin");
        writeExecutable(NodePath.join(misePath, "package-tool"));
        const mise = yield* resolveProviderMaintenanceCapabilitiesEffect(selfUpdating, {
          binaryPath: NodePath.join(misePath, "package-tool"),
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        expect(mise.update).toBeNull();

        // A mise command wrapper is a symlink to the mise binary, not to the tool.
        const miseBinary = NodePath.join(tempDir, "usr", "bin", "mise");
        writeExecutable(miseBinary);
        const wrapper = NodePath.join(
          tempDir,
          ".local",
          "share",
          "mise",
          "command-wrappers",
          "bin",
          "package-tool",
        );
        NodeFS.mkdirSync(NodePath.dirname(wrapper), { recursive: true });
        NodeFS.symlinkSync(miseBinary, wrapper);
        const viaWrapper = yield* resolveProviderMaintenanceCapabilitiesEffect(selfUpdating, {
          binaryPath: wrapper,
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        expect(viaWrapper.update).toBeNull();
      }),
  );

  it.effect.skipIf(!symlinksSupported)("updates Yarn global installs with yarn", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-yarn-capabilities");
      const link = linkIntoPackage(tempDir, "package-tool", [
        ".config",
        "yarn",
        "global",
        "node_modules",
        "@example",
        "package-tool",
      ]);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: link,
        env: { PATH: "" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update).toMatchObject({
        command: "yarn global add @example/package-tool@latest",
        lockKey: "yarn-global",
      });
      expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0")?.args).toEqual([
        "global",
        "add",
        "@example/package-tool@2.0.0",
      ]);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "updates Volta installs only when Volta has the package",
    () =>
      Effect.gen(function* () {
        const voltaHome = NodePath.join(yield* makeTempDir("t3-volta-capabilities"), ".volta");
        const shim = NodePath.join(voltaHome, "bin", "volta-shim");
        writeExecutable(shim);
        const link = NodePath.join(voltaHome, "bin", "package-tool");
        NodeFS.symlinkSync(shim, link);
        const resolve = resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
          binaryPath: link,
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect((yield* resolve).update).toBeNull();
        NodeFS.mkdirSync(
          NodePath.join(voltaHome, "tools", "image", "packages", "@example", "package-tool"),
          { recursive: true },
        );
        expect((yield* resolve).update).toMatchObject({
          command: "volta install @example/package-tool@latest",
          lockKey: "volta",
        });
      }),
  );

  it.effect.skipIf(windowsHost)("upgrades with the keg's own brew when brew is not on PATH", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-homebrew-keg-brew");
      const brewPath = NodePath.join(tempDir, "bin", "brew");
      writeExecutable(brewPath);
      const kegBinary = NodePath.join(tempDir, "Cellar", "package-tool", "1.0.0", "bin", "tool");
      writeExecutable(kegBinary);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: kegBinary,
        env: { PATH: "" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner((_command, args) => (args[0] === "--prefix" ? `${tempDir}\n` : "{}")),
        ),
      );

      expect(capabilities.update).toMatchObject({
        executable: brewPath,
        args: ["upgrade", "package-tool"],
        lockKey: "homebrew",
      });
    }),
  );

  it.effect("starts a fresh read instead of joining the resolution already running", () =>
    Effect.gen(function* () {
      const releaseStale = yield* Deferred.make<void>();
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.suspend(() => {
          resolutions += 1;
          return resolutions === 1
            ? Deferred.await(releaseStale).pipe(Effect.as(manualPackageTool))
            : Effect.succeed(manualPackageTool);
        }),
      );

      const advisory = yield* Effect.forkChild(resolve(), { startImmediately: true });
      const fresh = yield* Effect.forkChild(resolve({ fresh: true }), { startImmediately: true });
      expect(resolutions).toBe(2);
      expect(fresh.pollUnsafe()).toBeDefined();
      yield* Deferred.succeed(releaseStale, undefined);
      expect(yield* Fiber.join(fresh)).toEqual(manualPackageTool);
      yield* Fiber.join(advisory);
    }),
  );

  it.effect("resolves again after the first read is interrupted", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.suspend(() => {
          resolutions += 1;
          return resolutions === 1
            ? Effect.never
            : Deferred.await(release).pipe(Effect.as(manualPackageTool));
        }),
      );

      const first = yield* Effect.forkChild(resolve(), { startImmediately: true });
      yield* Fiber.interrupt(first);

      const owner = yield* Effect.forkChild(resolve(), { startImmediately: true });
      const waiter = yield* Effect.forkChild(resolve(), { startImmediately: true });
      yield* Fiber.interrupt(owner);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(waiter)).toEqual(manualPackageTool);
      expect(yield* resolve()).toEqual(manualPackageTool);
      expect(resolutions).toBe(2);
    }),
  );
});
