// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
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

const driver = (value: string) => ProviderDriverKind.make(value);
// Shell stubs use POSIX paths; Windows temp paths cannot split on colon.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4()),
    Effect.map((id) => NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), `${name}-${id}`)),
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

function stdoutSpawner(
  onSpawn: (command: string, args: ReadonlyArray<string>) => string,
  exitCodeOf: (args: ReadonlyArray<string>) => number = () => 0,
) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCodeOf(args))),
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

it.layer(
  NodeServices.layer.pipe(Layer.merge(Layer.succeed(HostProcess.Environment, { PATH: "" }))),
)("providerMaintenance", (it) => {
  it.effect("prefers the installer's own latest version over the npm registry", () =>
    resolveLatestProviderVersion({ ...manualPackageTool, latestVersion: "1.2.0" }).pipe(
      Effect.provide(ProviderLatestVersions.layer),
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

  it.effect("reads the latest version from the npm registry", () =>
    resolveLatestProviderVersion(manualPackageTool).pipe(
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "1.2.3" }))),
        ),
      ),
      Effect.map((version) => {
        expect(version).toBe("1.2.3");
      }),
    ),
  );

  it.effect("gives up on a registry body that stalls after the headers", () =>
    Effect.gen(function* () {
      const lookup = yield* resolveLatestProviderVersion(manualPackageTool).pipe(
        Effect.provide(ProviderLatestVersions.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new ReadableStream()))),
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("4 seconds");
      expect(lookup.pollUnsafe()).toBeDefined();
      expect(yield* Fiber.join(lookup)).toBeNull();
    }),
  );

  it.effect("does not fetch latest provider versions when update checks are disabled", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      { ...installedPackageToolProvider, installedVersion: "1.1.0" },
      manualPackageTool,
      { enableProviderUpdateChecks: false },
    ).pipe(
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("disabled provider update checks should not make an HTTP request"),
        ),
      ),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "unknown",
          currentVersion: "1.1.0",
          latestVersion: null,
          checkedAt: "2026-04-10T00:00:00.000Z",
        });
      }),
    ),
  );

  it.effect.each([
    { install: "native", stdout: '"1.2.0"', exitCode: 0, latest: "1.2.0" },
    { install: "manual", stdout: '["1.2.0"]', exitCode: 0, latest: "1.2.0" },
    { install: "npm", stdout: '"1.2.0"', exitCode: 0, latest: "1.2.0" },
    { install: "native", stdout: "", exitCode: 1, latest: null },
    { install: "npm", stdout: '"1.2.0"', exitCode: 1, latest: null },
    { install: "native", stdout: "not json", exitCode: 0, latest: null },
    { install: "manual", stdout: '["1.2.0", "1.3.0"]', exitCode: 0, latest: null },
    { install: "manual", stdout: '""', exitCode: 0, latest: null },
  ])(
    "uses npm's registry for $install installs (exit $exitCode, output $stdout)",
    (fixture) =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-registry-version");
        const npmBinDir = NodePath.join(tempDir, "npm-bin");
        writeExecutable(NodePath.join(npmBinDir, "npm"));
        const binaryPath =
          fixture.install === "npm"
            ? linkIntoPackage(tempDir, "package-tool", [
                "lib",
                "node_modules",
                "@example",
                "package-tool",
              ])
            : NodePath.join(tempDir, ".local/bin/native-package-tool");
        if (fixture.install !== "npm") writeExecutable(binaryPath);
        let probes = 0;
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          fixture.install === "native" ? nativePackageToolUpdate : packageToolUpdate,
          { binaryPath, env: { PATH: fixture.install === "npm" ? npmBinDir : "" } },
        ).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: npmBinDir }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner(
              (command, args) => {
                probes++;
                expect(command).toBe(NodePath.join(npmBinDir, "npm"));
                expect(args).toEqual([
                  "view",
                  "--global",
                  ...(fixture.install === "npm" ? ["--prefix", tempDir] : []),
                  "--json",
                  `${capabilities.packageName}@latest`,
                  "version",
                ]);
                return fixture.stdout;
              },
              () => fixture.exitCode,
            ),
          ),
        );
        const program = Effect.gen(function* () {
          yield* enrichProviderSnapshotWithVersionAdvisory(
            installedPackageToolProvider,
            capabilities,
            { enableProviderUpdateChecks: false },
          );
          expect(probes).toBe(0);
          const snapshot = yield* enrichProviderSnapshotWithVersionAdvisory(
            installedPackageToolProvider,
            capabilities,
          );
          expect(snapshot.versionAdvisory?.latestVersion).toBe(fixture.latest);
          expect(probes).toBe(1);
          expect(yield* resolveLatestProviderVersion(capabilities)).toBe(fixture.latest);
          expect(probes).toBe(1);
          yield* invalidateLatestProviderVersion(capabilities);
          expect(yield* resolveLatestProviderVersion(capabilities)).toBe(fixture.latest);
          expect(probes).toBe(2);
        });
        yield* program.pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([
              ["@example/package-tool", "9.9.9"],
              ["@example/native-package-tool", "9.9.9"],
            ]),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Effect.die("a configured npm lookup must not fall back to public npm"),
            ),
          ),
        );
      }),
    { skip: !symlinksSupported || windowsHost },
  );

  it("pins the advertised stable version in a pnpm-global update command", () => {
    const advisoryFor = (
      maintenanceCapabilities: ReturnType<typeof makeProviderMaintenanceCapabilities>,
      latestVersion: string,
    ) =>
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion,
        maintenanceCapabilities,
      }).updateCommand;
    const pnpmTool = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateExecutable: "pnpm",
      updateArgs: [
        "add",
        "-g",
        "--allow-build=@example/package-tool",
        "@example/package-tool@latest",
      ],
      updateLockKey: "pnpm-global",
    });

    expect(advisoryFor(pnpmTool, "1.1.0")).toBe(
      "pnpm add -g --allow-build=@example/package-tool @example/package-tool@1.1.0",
    );
    // A prerelease cannot be pinned safely, so pnpm keeps @latest.
    expect(advisoryFor(pnpmTool, "1.1.0-beta.1")).toBe(
      "pnpm add -g --allow-build=@example/package-tool @example/package-tool@latest",
    );
    // Only pnpm's minimumReleaseAge skips fresh releases; npm keeps @latest.
    expect(
      advisoryFor(
        makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@example/package-tool@latest"],
          updateLockKey: "npm-global:/opt/node",
        }),
        "1.1.0",
      ),
    ).toBe("npm install -g @example/package-tool@latest");
  });

  it("names the install to update when it is behind but unowned", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: {
          ...manualPackageTool,
          installPath: "/Applications/Tool.app/Contents/Resources/bin/package-tool",
        },
      }),
    ).toMatchObject({
      status: "behind_latest",
      latestVersion: "2.1.117",
      updateCommand: null,
      canUpdate: false,
      message:
        "Version 2.1.117 is out. T3 Code runs /Applications/Tool.app/Contents/Resources/bin/package-tool; update it with the app or tool that installed it.",
    });
  });

  it("offers the update when an owned install is behind", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@example/package-tool@latest"],
          updateLockKey: "npm-global:/usr/local",
        }),
      }),
    ).toMatchObject({
      status: "behind_latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("shows the Chocolatey upgrade command without offering to run it", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("claudeAgent"),
        currentVersion: "2.1.304",
        latestVersion: "2.1.306",
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: driver("claudeAgent"),
          packageName: "@anthropic-ai/claude-code",
          installPath: "C:\\ProgramData\\chocolatey\\bin\\claude.exe",
          manualCommand: "choco upgrade claude-code",
        }),
      }),
    ).toMatchObject({
      canUpdate: false,
      canInstallVersion: false,
      updateCommand: "choco upgrade claude-code",
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
    "pins npm updates to the global prefix that owns the package and the provider's PATH",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-npm-capabilities");
        const link = linkIntoPackage(tempDir, "package-tool", [
          "lib",
          "node_modules",
          "@example",
          "package-tool",
        ]);
        // A version manager's Node, which only the provider's settings put on PATH.
        const providerEnv = { PATH: NodePath.join(tempDir, "bin") };

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: providerEnv,
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
            env: providerEnv,
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
    expect(
      npmGlobalPrefixFromCommandPath(
        "/work/app/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBeNull();
  });

  // The Windows Codex bin junction resolves into CODEX_HOME/packages/standalone/current/bin.
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
      ).pipe(Effect.provideService(HostProcess.Platform, "win32"));

      expect(capabilities.update).toMatchObject({
        executable: visiblePath,
        args: ["update"],
        lockKey: "codex-native",
      });
    }),
  );

  it.effect(
    "keeps an unrecognized install manual-only when the native updater requires its path",
    () =>
      Effect.gen(function* () {
        const systemPath =
          "/usr/local/lib/codex/releases/rust-v0.162.1-x86_64-unknown-linux-musl/bin/codex";
        const capabilities = yield* resolvePackageManagedProviderMaintenance(
          {
            provider: driver("codex"),
            npmPackageName: "@openai/codex",
            nativeUpdate: {
              args: ["update"],
              isCommandPath: isNativeTestCommandPath("/packages/standalone/"),
              requiresCommandPath: true,
            },
          },
          {
            binaryPath: "codex",
            resolvedCommandPath: "/usr/local/bin/codex",
            realCommandPath: systemPath,
            env: {},
            platform: "linux",
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        );

        expect(capabilities.update).toBeNull();
        expect(capabilities.installPath).toBe(systemPath);
      }),
  );

  const claudeUpdate = {
    provider: driver("claudeAgent"),
    npmPackageName: "@anthropic-ai/claude-code",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isNativeTestCommandPath("/.local/bin/claude"),
    },
  };
  const otherProviderUpdate = {
    provider: driver("nativePackageTool"),
    npmPackageName: "@example/native-package-tool",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
    },
  };
  const resolveInstall = (input: {
    readonly definition: PackageManagedProviderMaintenanceDefinition;
    readonly resolved: string;
    readonly real: string;
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
  }) =>
    resolvePackageManagedProviderMaintenance(input.definition, {
      binaryPath: "claude",
      resolvedCommandPath: input.resolved,
      realCommandPath: input.real,
      env: input.env ?? {},
      platform: input.platform ?? "win32",
    }).pipe(
      Effect.provideService(HostProcess.Platform, input.platform ?? "win32"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
    );
  const userWinGetLink = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe";
  const userWinGetPackage =
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  const machineWinGetLink = "C:\\Program Files\\WinGet\\Links\\claude.exe";
  const machineWinGetPackage =
    "C:\\Program Files\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  const nativeClaude = "C:\\Users\\me\\.local\\bin\\claude.exe";

  it.effect.each([
    { name: "a user-scope link", resolved: userWinGetLink, real: userWinGetPackage },
    { name: "a user-scope package", resolved: userWinGetPackage, real: userWinGetPackage },
    { name: "a machine-scope package", resolved: machineWinGetPackage, real: machineWinGetPackage },
    { name: "a machine-scope link alone", resolved: machineWinGetLink, real: machineWinGetLink },
    {
      name: "a mixed-case link",
      resolved: "c:\\USERS\\me\\appdata\\local\\MICROSOFT\\winget\\links\\Claude.EXE",
      real: userWinGetPackage.toUpperCase(),
    },
    { name: "a native-looking alias", resolved: nativeClaude, real: userWinGetPackage },
  ] as const)("keeps a WinGet Claude install manual-only through $name", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({ definition: claudeUpdate, ...fixture });

      expect(capabilities.update).toBeNull();
    }),
  );

  const chocolateyShim = "C:\\ProgramData\\chocolatey\\bin\\claude.exe";
  const chocolateyPackage = "C:\\ProgramData\\chocolatey\\lib\\claude-code\\tools\\claude.exe";

  it.effect.each([
    { name: "the shimgen shim", resolved: chocolateyShim, real: chocolateyShim },
    { name: "the package binary", resolved: chocolateyPackage, real: chocolateyPackage },
    {
      name: "a custom root",
      resolved: "D:\\Tools\\Choco\\bin\\claude.exe",
      real: "D:\\Tools\\Choco\\bin\\claude.exe",
      env: { ChocolateyInstall: "D:\\Tools\\Choco" },
    },
    {
      name: "a custom root package",
      resolved: "D:\\Tools\\Choco\\lib\\claude-code\\tools\\claude.exe",
      real: "D:\\Tools\\Choco\\lib\\claude-code\\tools\\claude.exe",
      env: { ChocolateyInstall: "D:\\Tools\\Choco" },
    },
    {
      name: "a mixed-case custom root with a trailing separator",
      resolved: "D:\\Tools\\Choco\\bin\\Claude.EXE",
      real: "D:\\Tools\\Choco\\bin\\Claude.EXE",
      env: { ChocolateyInstall: "d:/tools/choco/" },
    },
    { name: "a native-looking alias", resolved: nativeClaude, real: chocolateyPackage },
  ] as const)("keeps a Chocolatey Claude install manual-only through $name", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({ definition: claudeUpdate, ...fixture });

      expect(capabilities.update).toBeNull();
      expect(capabilities.installPath).toBe(fixture.real);
      expect(capabilities.latestVersion).toBeNull();
      expect(capabilities.lookupLatestVersion).toBeDefined();
      expect(capabilities.manualCommand).toBe("choco upgrade claude-code");
    }),
  );

  it.effect("keeps a Chocolatey-shaped path off Windows on the native updater", () =>
    Effect.gen(function* () {
      const commandPath = "/home/me/chocolatey/bin/claude.exe";
      const capabilities = yield* resolveInstall({
        definition: claudeUpdate,
        resolved: commandPath,
        real: commandPath,
        platform: "linux",
      });

      expect(capabilities.update).toMatchObject({ lockKey: "claudeAgent-native" });
    }),
  );

  // Chocolatey publishes behind npm, so comparing against the registry would
  // report an update `choco upgrade` cannot install yet.
  it.effect("compares a Chocolatey Claude install against choco search", () =>
    Effect.gen(function* () {
      const probes: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const capabilities = yield* resolvePackageManagedProviderMaintenance(claudeUpdate, {
        binaryPath: "claude",
        resolvedCommandPath: chocolateyShim,
        realCommandPath: chocolateyShim,
        env: {},
        platform: "win32",
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner((command, args) => {
            probes.push({ command, args });
            return "claude-code|2.1.304\r\n";
          }),
        ),
      );
      expect(probes).toEqual([]);

      const latest = yield* resolveLatestProviderVersion(capabilities).pipe(
        Effect.provide(ProviderLatestVersions.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("the installer's latest should not come from npm")),
        ),
      );

      expect(latest).toBe("2.1.304");
      expect(probes.map(({ command }) => NodePath.basename(command).replace(/\.\w+$/, ""))).toEqual(
        ["choco"],
      );
      expect(probes[0]?.args).toEqual(["search", "claude-code", "--exact", "--limit-output"]);
      expect(
        createProviderVersionAdvisory({
          driver: driver("claudeAgent"),
          currentVersion: "2.1.304",
          latestVersion: latest,
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({ status: "current", canUpdate: false, canInstallVersion: false });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stays unknown when choco search fails instead of asking npm", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolvePackageManagedProviderMaintenance(claudeUpdate, {
        binaryPath: "claude",
        resolvedCommandPath: chocolateyShim,
        realCommandPath: chocolateyShim,
        env: {},
        platform: "win32",
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner(
            () => "",
            () => 1,
          ),
        ),
      );

      const latest = yield* resolveLatestProviderVersion(capabilities).pipe(
        Effect.provide(ProviderLatestVersions.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("a failed choco search should not fall back to npm")),
        ),
      );

      expect(latest).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      name: "a native install",
      definition: claudeUpdate,
      resolved: nativeClaude,
      real: nativeClaude,
    },
    {
      name: "a WinGet-shaped path off Windows",
      definition: claudeUpdate,
      resolved: "/home/me/winget/links/claude.exe",
      real: "/home/me/winget/links/claude.exe",
      platform: "linux",
    },
    {
      name: "a WinGet-named folder outside the WinGet roots",
      definition: claudeUpdate,
      resolved: "C:\\Work\\WinGet\\Links\\claude.exe",
      real: "C:\\Work\\WinGet\\Links\\claude.exe",
    },
    {
      name: "a WinGet-named folder inside another directory",
      definition: claudeUpdate,
      resolved: "C:\\Work\\Microsoft\\WinGet\\Links\\claude.exe",
      real: "C:\\Work\\Microsoft\\WinGet\\Links\\claude.exe",
    },
    {
      name: "another provider in WinGet",
      definition: otherProviderUpdate,
      resolved: userWinGetLink,
      real: userWinGetPackage,
    },
    {
      name: "a claude-code tools path outside Chocolatey",
      definition: claudeUpdate,
      resolved: "C:\\Work\\lib\\claude-code\\tools\\claude.exe",
      real: "C:\\Work\\lib\\claude-code\\tools\\claude.exe",
    },
    {
      name: "another WinGet package",
      definition: claudeUpdate,
      resolved: userWinGetPackage.replace("ClaudeCode_", "ClaudeCodeOther_"),
      real: userWinGetPackage.replace("ClaudeCode_", "ClaudeCodeOther_"),
    },
  ] as const)("keeps the native updater for $name", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall(fixture);

      expect(capabilities.update).toMatchObject({
        executable: fixture.resolved,
        args: ["update"],
        lockKey: `${fixture.definition.provider}-native`,
      });
    }),
  );

  it.effect.each([
    {
      name: "the default home",
      resolved: "/Users/theo/.vite-plus/bin/claude",
      real: "/Users/theo/.vite-plus/current/bin/vp",
      platform: "darwin",
    },
    {
      name: "the XDG home",
      resolved: "/home/theo/.local/share/vite-plus/bin/claude",
      real: "/home/theo/.local/share/vite-plus/current/bin/vp",
      platform: "linux",
    },
    {
      name: "the Windows home",
      resolved: "C:\\Users\\Theo\\AppData\\Local\\vite-plus\\bin\\claude.cmd",
      real: "C:\\Users\\Theo\\AppData\\Local\\vite-plus\\packages\\@anthropic-ai\\claude-code\\lib\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
      platform: "win32",
    },
  ] as const)("updates a Vite+ global install in $name with vp", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({ definition: claudeUpdate, ...fixture });

      expect(capabilities.update).toMatchObject({
        command: "vp i -g @anthropic-ai/claude-code",
        lockKey: "vite-plus-global",
      });
    }),
  );

  it.effect("keeps a project folder named vite-plus manual-only", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall({
        definition: claudeUpdate,
        resolved: "/work/vite-plus/bin/claude",
        real: "/work/vite-plus/node_modules/@anthropic-ai/claude-code/cli.js",
        platform: "linux",
      });

      expect(capabilities.update).toBeNull();
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
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );

      expect(capabilities.update).toMatchObject({
        executable: "npm",
        args: ["install", "-g", "--prefix", tempDir, expect.any(String), expect.any(String)],
      });

      const script = NodePath.join(tempDir, "package-tool");
      writeExecutable(script);
      const posix = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: script,
        env: { PATH: "" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
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

it("pins only owned package-manager installs and preserves their execution context", () => {
  const capabilities = makeProviderMaintenanceCapabilities({
    provider: driver("codex"),
    packageName: "@openai/codex",
    updateExecutable: "npm",
    updateLockKey: "npm-global:/opt/node",
    updateArgs: [
      "install",
      "-g",
      "--prefix",
      "/opt/node",
      "--allow-scripts=@openai/codex",
      "@openai/codex@latest",
    ],
    env: { PATH: "/opt/node/bin" },
  });
  const pinned = makeTargetedProviderUpdateAction(capabilities, "2.0.0");
  expect(pinned).toMatchObject({
    executable: "npm",
    lockKey: capabilities.update?.lockKey,
    env: capabilities.update?.env,
    args: [
      "install",
      "-g",
      "--prefix",
      "/opt/node",
      "--allow-scripts=@openai/codex",
      "@openai/codex@2.0.0",
    ],
  });
  expect(pinned?.command).toContain("@openai/codex@2.0.0");
  for (const lockKey of ["codex-native", "homebrew", "manual"]) {
    expect(
      makeTargetedProviderUpdateAction(
        { ...capabilities, update: { ...capabilities.update!, lockKey } },
        "2.0.0",
      ),
    ).toBeNull();
  }
  expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0; rm -rf /")).toBeNull();
});
