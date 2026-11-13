// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  invalidateLatestProviderVersion,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  npmGlobalPrefixFromCommandPath,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type PackageManagedProviderMaintenanceDefinition,
} from "./maintenanceResolver.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  driver,
  installedPackageToolProvider,
  isNativeTestCommandPath,
  linkIntoPackage,
  makeTempDir,
  manualPackageTool,
  nativePackageToolUpdate,
  noSpawn,
  packageToolUpdate,
  stdoutSpawner,
  windowsHost,
  writeExecutable,
} from "./maintenanceResolver.helpers2.testkit.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(HostProcess.Environment, { PATH: "" }),
  ),
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
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
});
