// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  homebrewOwnershipFromCommandPath,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  npmGlobalPrefixFromCommandPath,
  parseHomebrewLatestVersion,
  ProviderVersionCache,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const driver = (value: string) => ProviderDriverKind.make(value);
// These write `#!/bin/sh` stubs and evaluate them with darwin/linux path
// semantics; a Windows temp path cannot be split on `:`.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
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
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
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
const manualPackageTool: ProviderMaintenanceCapabilities = {
  provider: driver("packageTool"),
  packageName: "@example/package-tool",
  update: null,
};

function writeExecutable(path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "#!/bin/sh\n");
  NodeFS.chmodSync(path, 0o755);
}

/** Symlink `<tempDir>/bin/<name>` into a package entry point, like npm/pnpm do. */
function linkIntoPackage(tempDir: string, name: string, packageSegments: ReadonlyArray<string>) {
  const target = NodePath.join(tempDir, ...packageSegments, "bin", `${name}.js`);
  writeExecutable(target);
  const link = NodePath.join(tempDir, "bin", name);
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
}

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("maintenance resolution should not spawn a process here"),
);

function stdoutSpawner(onSpawn: (command: string, args: ReadonlyArray<string>) => string) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(executable, args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

it.layer(NodeServices.layer)("providerMaintenance", (it) => {
  it.effect("reads cached versions through the injectable cache reference", () =>
    resolveLatestProviderVersion(manualPackageTool).pipe(
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

  it.effect("prefers the installer's own latest version over the npm registry", () =>
    resolveLatestProviderVersion({ ...manualPackageTool, latestVersion: "1.2.0" }).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("installer-reported latest should not make an HTTP request"),
        ),
      ),
      Effect.map((version) => {
        expect(version).toBe("1.2.0");
      }),
    ),
  );

  it.effect("does not fetch latest provider versions when update checks are disabled", () =>
    enrichProviderSnapshotWithVersionAdvisory(installedPackageToolProvider, manualPackageTool, {
      enableProviderUpdateChecks: false,
    }).pipe(
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

  it("keeps the manual update hint when the install is behind but unowned", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: manualPackageTool,
      }),
    ).toMatchObject({
      status: "behind_latest",
      latestVersion: "2.1.117",
      updateCommand: null,
      canUpdate: false,
      message: "Install the update now or review provider settings.",
    });
  });

  it.effect("stays manual-only when the binary cannot be located", () =>
    resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
      binaryPath: "package-tool",
      env: { PATH: "" },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      Effect.map((capabilities) => {
        expect(capabilities).toEqual(manualPackageTool);
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "pins npm updates to the global prefix that owns the package",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-npm-capabilities");
        const link = linkIntoPackage(tempDir, "package-tool", [
          "lib",
          "node_modules",
          "@example",
          "package-tool",
        ]);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities).toEqual({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          update: {
            command: `npm install -g --prefix ${tempDir} --allow-scripts=@example/package-tool @example/package-tool@latest`,
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              tempDir,
              "--allow-scripts=@example/package-tool",
              "@example/package-tool@latest",
            ],
            lockKey: `npm-global:${normalizeCommandPath(tempDir)}`,
          },
        });
      }),
  );

  it("derives the npm prefix only from the global lib/node_modules layout", () => {
    expect(
      npmGlobalPrefixFromCommandPath(
        "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBe("/usr/local");
    // A copy nested inside another package is not a global install.
    expect(
      npmGlobalPrefixFromCommandPath(
        "/usr/local/lib/node_modules/other/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBeNull();
    expect(
      npmGlobalPrefixFromCommandPath(
        "/lib/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBe("/");
    // Neither is a project-local dependency.
    expect(
      npmGlobalPrefixFromCommandPath(
        "/work/app/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBeNull();
  });

  // The Codex Windows installer exposes `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin`
  // as a junction into `%CODEX_HOME%\\packages\\standalone\\current\\bin`. Node's
  // realpath follows junctions, so the real path carries the standalone marker
  // even though the visible path does not.
  it.effect("recognizes a Windows standalone install through its junctioned bin dir", () =>
    Effect.gen(function* () {
      const visiblePath =
        "C:\\Users\\Theo\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
      const realPath =
        "C:\\Users\\Theo\\.codex\\packages\\standalone\\releases\\0.120.0-x86_64\\bin\\codex.exe";
      const capabilities = yield* resolvePackageManagedProviderMaintenance(
        {
          provider: driver("codex"),
          npmPackageName: "@openai/codex",
          nativeUpdate: {
            args: ["update"],
            isCommandPath: isNativeTestCommandPath("/packages/standalone/"),
          },
        },
        {
          binaryPath: "codex",
          resolvedCommandPath: visiblePath,
          realCommandPath: realPath,
          env: {},
          platform: "win32",
        },
      ).pipe(Effect.provideService(HostProcessPlatform, "win32"));

      expect(capabilities.update).toMatchObject({
        executable: visiblePath,
        args: ["update"],
        lockKey: "codex-native",
      });
    }),
  );

  it.effect("proves Windows npm ownership from the package manifest beside the shim", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-windows-capabilities");
      const shim = NodePath.join(tempDir, "package-tool.cmd");
      NodeFS.mkdirSync(tempDir, { recursive: true });
      NodeFS.writeFileSync(shim, "@echo off\r\n");
      NodeFS.mkdirSync(NodePath.join(tempDir, "node_modules", "@example", "package-tool"), {
        recursive: true,
      });
      NodeFS.writeFileSync(
        NodePath.join(tempDir, "node_modules", "@example", "package-tool", "package.json"),
        "{}",
      );

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: shim,
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );

      expect(capabilities.update).toMatchObject({
        executable: "npm",
        args: ["install", "-g", "--prefix", tempDir, expect.any(String), expect.any(String)],
      });

      // The same layout on POSIX is a project checkout, not a global install.
      const script = NodePath.join(tempDir, "package-tool");
      writeExecutable(script);
      const posix = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: script,
        env: { PATH: "" },
      }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );
      expect(posix.update).toBeNull();
    }),
  );

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

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toMatchObject({
          command: "pnpm add -g @example/package-tool@latest",
          lockKey: "pnpm-global",
        });
      }),
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
          Effect.provideService(HostProcessPlatform, "darwin"),
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
        Effect.provideService(HostProcessPlatform, "darwin"),
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

  // Regression for #9850: an explicit native path outside PATH, with spaces,
  // must be what actually gets spawned.
  it.effect.skipIf(windowsHost)("runs an explicit native updater outside PATH", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-update");
      const nativePath = NodePath.join(
        tempDir,
        "with spaces",
        ".local",
        "bin",
        "native-package-tool",
      );
      NodeFS.mkdirSync(NodePath.dirname(nativePath), { recursive: true });
      NodeFS.writeFileSync(nativePath, "#!/bin/sh\nprintf '%s' \"$1\"\n");
      NodeFS.chmodSync(nativePath, 0o755);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        nativePackageToolUpdate,
        { binaryPath: nativePath, env: { PATH: "" } },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update?.executable).toBe(nativePath);
      const result = NodeChildProcess.spawnSync(
        capabilities.update!.executable,
        capabilities.update!.args,
        { env: { PATH: "" }, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("update");
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "prefers npm ownership over the Node keg the package lives under",
    () =>
      Effect.gen(function* () {
        // `brew install node` keeps npm globals inside the node keg.
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

  it("recognizes Homebrew kegs and casks from the real executable path", () => {
    expect(
      homebrewOwnershipFromCommandPath("/opt/homebrew/Cellar/claude-code@latest/2.1.0/bin/claude"),
    ).toEqual({ kind: "formula", name: "claude-code@latest", prefix: "/opt/homebrew" });
    expect(homebrewOwnershipFromCommandPath("/usr/local/Caskroom/codex/0.148.0/codex")).toEqual({
      kind: "cask",
      name: "codex",
      prefix: "/usr/local",
    });
    // A plain /usr/local/bin binary is not evidence of Homebrew (#8832).
    expect(homebrewOwnershipFromCommandPath("/usr/local/bin/codex")).toBeNull();
    // A keg elsewhere reports its prefix so the resolver can reject it against
    // `brew --prefix`.
    expect(homebrewOwnershipFromCommandPath("/srv/Cellar/claude/1.0.0/bin/claude")).toMatchObject({
      prefix: "/srv",
    });
  });

  it.effect.skipIf(windowsHost)(
    "stays manual-only for an explicit binary path that does not exist",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-missing-native-capabilities");
        const missingPath = NodePath.join(tempDir, ".local", "bin", "native-package-tool");

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          { binaryPath: missingPath, env: { PATH: "" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toBeNull();
      }),
  );

  it.effect.each([
    { directory: "Caskroom", name: "package-tool", kind: "cask" },
    { directory: "Cellar", name: "package-tool", kind: "formula" },
    { directory: "Cellar", name: "package-tool@latest", kind: "formula" },
  ] as const)(
    "upgrades the owning Homebrew $kind $name through an executable alias",
    (fixture) =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-homebrew-capabilities");
        const brewBinDir = NodePath.join(tempDir, "brew-bin");
        const brewPath = NodePath.join(brewBinDir, "brew");
        writeExecutable(brewPath);
        const ownedBinary = NodePath.join(
          tempDir,
          fixture.directory,
          fixture.name,
          "0.148.0",
          "package-tool-0.148.0",
        );
        writeExecutable(ownedBinary);
        const link = NodePath.join(tempDir, "bin", "custom-package-tool");
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
        NodeFS.symlinkSync(ownedBinary, link);
        const spawned: Array<ReadonlyArray<string>> = [];

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: brewBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner((command, args) => {
              spawned.push([command, ...args]);
              return args[0] === "--prefix"
                ? `${tempDir}\n`
                : JSON.stringify(
                    fixture.kind === "cask"
                      ? { casks: [{ version: "0.148.0,42" }] }
                      : { formulae: [{ versions: { stable: "0.148.0" } }] },
                  );
            }),
          ),
        );

        expect(spawned).toEqual([
          [brewPath, "--prefix"],
          [brewPath, "info", "--json=v2", fixture.name],
        ]);
        expect(capabilities).toEqual({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          latestVersion: "0.148.0",
          update: {
            command:
              fixture.kind === "cask"
                ? `brew upgrade --cask ${fixture.name}`
                : `brew upgrade ${fixture.name}`,
            executable: brewPath,
            args:
              fixture.kind === "cask"
                ? ["upgrade", "--cask", fixture.name]
                : ["upgrade", fixture.name],
            lockKey: "homebrew",
          },
        });
      }),
    { skip: !symlinksSupported },
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
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner(() => "/opt/homebrew\n"),
          ),
        );

        expect(capabilities).toEqual(manualPackageTool);
      }),
  );

  it("reads the stable formula version from brew info", () => {
    const info = JSON.stringify({ formulae: [{ versions: { stable: "2.1.5" } }] });
    const formula = { kind: "formula", name: "claude-code", prefix: "/opt/homebrew" } as const;
    expect(parseHomebrewLatestVersion(info, formula)).toBe("2.1.5");
    expect(parseHomebrewLatestVersion("not json", formula)).toBeNull();
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

        expect(capabilities).toEqual(manualPackageTool);
      }),
  );

  it.effect("caches resolution until a fresh read is requested", () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.sync(() => {
          resolutions += 1;
          return manualPackageTool;
        }),
      );
      yield* resolve();
      yield* resolve();
      expect(resolutions).toBe(1);
      yield* resolve({ fresh: true });
      yield* resolve();
      expect(resolutions).toBe(2);
    }),
  );
});
