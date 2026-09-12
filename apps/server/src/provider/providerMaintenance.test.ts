// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  homebrewOwnershipFromCommandPath,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceResolution,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  npmGlobalPrefixFromCommandPath,
  parseHomebrewLatestVersion,
  ProviderVersionCache,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type PackageManagedProviderMaintenanceDefinition,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { enrichGrokSnapshot } from "./Layers/GrokProvider.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const grokDefinition: PackageManagedProviderMaintenanceDefinition = {
  provider: driver("grok"),
  npmPackageName: "@xai-official/grok",
  wingetPackageId: "xAI.GrokBuild",
  nativeUpdate: null,
};
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
const noNpmRequest = HttpClient.make(() => Effect.die("installer versions must not query npm"));

function stdoutSpawner(
  onSpawn: (
    command: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
  ) => string | { stdout: string; code: number; stderr?: string },
) {
  return ChildProcessSpawner.make((command) => {
    const {
      command: executable,
      args,
      options,
    } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: { readonly env?: NodeJS.ProcessEnv };
    };
    const output = onSpawn(executable, args, options.env);
    const result = typeof output === "string" ? { stdout: output, code: 0 } : output;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(result.stdout)),
        stderr: Stream.encodeText(Stream.make(result.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

it.layer(NodeServices.layer)("providerMaintenance", (it) => {
  const windowsFixture = Effect.fn("windowsFixture")(function* (
    failure = "",
    scope = "user",
    definition: PackageManagedProviderMaintenanceDefinition = {
      provider: driver("packageTool"),
      npmPackageName: "@example/package-tool",
      wingetPackageId: "Example.PackageTool",
      nativeUpdate: { args: ["update"], isCommandPath: isNativeTestCommandPath("/.local/bin/") },
    },
    scoopPackage = "package-tool",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const probeStarted = yield* Deferred.make<void>();
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3 installer caffè 日本 O'Brien " });
    const managerRoot = NodePath.join(temp, "Scoop Root");
    const root = scope === "machine" ? NodePath.join(temp, "Global Scoop") : managerRoot;
    const current = NodePath.join(root, "apps", scoopPackage, "current");
    const target = NodePath.join(current, "tool.exe");
    const shim = NodePath.join(root, "shims", "tool.exe");
    const wingetName =
      failure === "renamed-install"
        ? "custom tool.exe"
        : definition.wingetPackageId === "OpenAI.Codex"
          ? "codex-x86_64-pc-windows-msvc.exe"
          : definition.wingetPackageId === "SST.opencode"
            ? "opencode.exe"
            : "tool.exe";
    const wingetTarget = NodePath.join(temp, "Microsoft", "WinGet", "Packages", wingetName);
    const indexPath = NodePath.join(
      NodePath.dirname(wingetTarget),
      `${definition.wingetPackageId}.db`,
    );
    const archive = failure.startsWith("archive") || failure === "directory-install";
    const wingetLink = NodePath.join(temp, "Microsoft", "WinGet", "Links", "tool.exe");
    const manager = NodePath.join(managerRoot, "shims", "scoop.EXE");
    const winget = NodePath.join(temp, "WindowsApps", "winget.EXE");
    const write = (file: string, text = "fixture") => {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, text);
    };
    for (const file of [target, shim, wingetTarget, manager, winget]) write(file);
    if (archive) {
      NodeFS.mkdirSync(NodePath.dirname(wingetLink), { recursive: true });
      if (failure !== "directory-install") NodeFS.symlinkSync(wingetTarget, wingetLink);
      const db = new NodeSqlite.DatabaseSync(indexPath);
      try {
        // WinGet Portable_1_0/PortableTable.cpp; archives store file and alias entries here.
        db.exec(
          "CREATE TABLE portable (filepath TEXT NOT NULL UNIQUE COLLATE NOCASE, filetype INT NOT NULL, sha256 BLOB, symlinktarget TEXT)",
        );
        const insert = db.prepare("INSERT INTO portable VALUES (?, ?, '', ?)");
        insert.run(wingetTarget, 1, "");
        insert.run(wingetLink, 3, wingetTarget);
        for (const name of ["codex-command-runner.exe", "codex-windows-sandbox-setup.exe"]) {
          const file = NodePath.join(NodePath.dirname(wingetTarget), name);
          insert.run(file, 1, "");
          insert.run(NodePath.join(NodePath.dirname(wingetLink), name), 3, file);
        }
      } finally {
        db.close();
      }
    }
    write(
      shim.replace(/\.exe$/, ".shim"),
      `path = "${failure === "foreign-target" ? wingetTarget : target}"\n${failure === "duplicate-target" ? `path = "${target}"` : ""}`,
    );
    write(
      NodePath.join(current, "install.json"),
      failure === "bad-metadata" ? "{}" : '{"bucket":"main"}',
    );
    write(
      NodePath.join(managerRoot, "buckets", "main", "bucket", `${scoopPackage}.json`),
      '{"version":"1.2.0"}',
    );
    if (failure === "missing-shim") NodeFS.unlinkSync(shim.replace(/\.exe$/, ".shim"));
    if (failure === "missing-manager") {
      NodeFS.unlinkSync(manager);
      NodeFS.unlinkSync(winget);
    }
    const env = {
      PATH: [NodePath.dirname(manager), NodePath.dirname(winget)].join(";"),
      PATHEXT: ".EXE;.CMD",
      ...(failure === "global-config"
        ? {}
        : { SCOOP_GLOBAL: failure === "wrong-global" ? temp : root }),
      TEST_INSTALLER: "instance",
    };
    const resolver = makePackageManagedProviderMaintenanceResolver(definition);
    let versionProbes = 0;
    const spawner = stdoutSpawner((_command, commandArgs, probeEnv) => {
      const script = commandArgs.includes("-EncodedCommand")
        ? Buffer.from(commandArgs.at(-1)!, "base64").toString("utf16le")
        : null;
      const args = script
        ? [...script.matchAll(/ '((?:[^']|'')*)'/g)]
            .slice(1)
            .map((match) => match[1]!.replaceAll("''", "'"))
        : commandArgs;
      expect(probeEnv).toEqual(env);
      if (args[0] === "config") return root;
      if (args[0] === "query") {
        if (failure.startsWith("missing-uninstall")) {
          if (args.includes("/s"))
            return { stdout: "", stderr: "Missing or inaccessible", code: 1 };
          return failure === "missing-uninstall-unreadable"
            ? { stdout: "", stderr: "Access denied", code: 1 }
            : failure === "missing-uninstall-empty"
              ? ""
              : `${args[1]}\\${failure === "missing-uninstall-present" ? "Uninstall" : "Explorer"}\n`;
        }
        if (failure === "registry-failure") return { stdout: "", code: 2 };
        const key = `HKEY_CURRENT_USER\\Software\\${definition.wingetPackageId}`;
        if (failure === "registry-partial")
          return { stdout: key, code: 0, stderr: "Access denied" };
        const matchesScope =
          args[1]!.startsWith(scope === "user" ? "HKCU" : "HKLM") && args.at(-1) === "/reg:64";
        if (args.includes("/s"))
          return matchesScope && failure !== "no-ownership"
            ? `${key}\n${failure === "duplicate-install" ? `${key}-other\n` : ""}`
            : { stdout: "End of search: 0 match(es) found.", code: 1 };
        const recordTarget =
          failure === "wrong-target" || args[1]!.endsWith("-other") ? target : wingetTarget;
        return `${key}\n    WinGetPackageIdentifier    REG_SZ    ${definition.wingetPackageId}\n    WinGetSourceIdentifier    REG_SZ    source-id\n    WinGetInstallerType    REG_SZ    portable\n    InstallLocation    REG_SZ    ${NodePath.dirname(wingetTarget)}${failure === "directory-install" ? NodePath.sep : ""}\n${archive ? (failure === "directory-install" ? "    InstallDirectoryAddedToPath    REG_DWORD    0x1" : "") : `    TargetFullPath    REG_SZ    ${recordTarget}\n    SymlinkFullPath    REG_SZ    ${wingetTarget}`}`;
      }
      if (args[0] === "source") {
        const source = JSON.stringify({
          Identifier: failure === "wrong-source" ? "another-source" : "source-id",
          Name: "private source",
        });
        return failure === "duplicate-source" ? `${source}\n${source}` : source;
      }
      versionProbes++;
      expect(args).toEqual([
        "show",
        "--id",
        definition.wingetPackageId,
        "--exact",
        "--source",
        "private source",
        "--versions",
        "--accept-source-agreements",
        "--disable-interactivity",
      ]);
      return failure === "show-failure"
        ? { stdout: "error 9.9.9", code: 1 }
        : "Versions\n--------\n1.0.0\n1.2.0\nError 9.9.9";
    });
    const resolve = (binaryPath: string) =>
      resolveProviderMaintenanceCapabilitiesEffect(resolver, { binaryPath, env }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          failure === "slow-probes"
            ? ChildProcessSpawner.make((command) =>
                Deferred.succeed(probeStarted, undefined).pipe(
                  Effect.andThen(spawner.spawn(command).pipe(Effect.delay("6 seconds"))),
                ),
              )
            : spawner,
        ),
      );
    return {
      resolve,
      resolver,
      spawner,
      shim,
      target,
      wingetTarget,
      wingetLink,
      indexPath,
      manager,
      winget,
      env,
      root,
      current,
      probeStarted,
      versionProbes: () => versionProbes,
    };
  });

  it.effect("defers WinGet version lookups until update checks are enabled", () =>
    Effect.gen(function* () {
      const f = yield* windowsFixture();
      const capabilities = yield* f.resolve(f.wingetTarget);
      const disabled = yield* enrichProviderSnapshotWithVersionAdvisory(
        installedPackageToolProvider,
        capabilities,
        { enableProviderUpdateChecks: false },
      );
      expect(disabled.versionAdvisory?.canUpdate).toBe(true);
      expect(f.versionProbes()).toBe(0);
      for (let index = 0; index < 2; index++) {
        const enabled = yield* enrichProviderSnapshotWithVersionAdvisory(
          installedPackageToolProvider,
          capabilities,
          { enableProviderUpdateChecks: true },
        );
        expect(enabled.versionAdvisory?.latestVersion).toBe("1.2.0");
      }
      expect(f.versionProbes()).toBe(1);
    }).pipe(Effect.provideService(HttpClient.HttpClient, noNpmRequest), Effect.scoped),
  );

  it.effect("binds each instance's services and keeps fresh ownership checks independent", () =>
    Effect.gen(function* () {
      const f = yield* windowsFixture();
      const makeResolution = (binaryPath: string) =>
        makeProviderMaintenanceResolution(f.resolver, { binaryPath, env: f.env }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
        );
      const scoop = yield* makeResolution(f.shim);
      const winget = yield* makeResolution(f.wingetTarget);
      // Execution must use the services captured at construction, not its caller's.
      yield* Effect.gen(function* () {
        expect((yield* scoop()).update?.executable).toBe(f.manager);
        expect((yield* winget()).update?.executable).toBe(f.winget);
        NodeFS.unlinkSync(f.wingetTarget);
        expect((yield* winget()).update?.executable).toBe(f.winget);
        expect((yield* winget({ fresh: true })).update).toBeNull();
        expect((yield* scoop({ fresh: true })).update?.executable).toBe(f.manager);
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
    }).pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.scoped),
  );

  it.effect("publishes Grok installer advisories even when the available version is unknown", () =>
    Effect.gen(function* () {
      for (const [installer, failure] of [
        ["scoop", ""],
        ["winget", ""],
        ["winget", "show-failure"],
      ]) {
        const f = yield* windowsFixture(failure, "user", grokDefinition, "grok-cli");
        const unknown = installer === "scoop" || failure === "show-failure";
        expect((yield* f.resolve(f.shim)).update).toMatchObject({
          executable: f.manager,
          args: ["update", "main/grok-cli"],
        });
        const published: ServerProvider[] = [];
        yield* enrichGrokSnapshot({
          snapshot: {
            ...installedPackageToolProvider,
            driver: driver("grok"),
            instanceId: ProviderInstanceId.make("grok_test"),
          },
          maintenanceCapabilities: yield* f.resolve(
            installer === "scoop" ? f.shim : f.wingetTarget,
          ),
          httpClient: HttpClient.make(() => Effect.die("Grok must not query npm")),
          publishSnapshot: (snapshot) =>
            Effect.sync(() => {
              published.push(snapshot);
            }),
        });
        expect(published).toHaveLength(1);
        expect(published[0]?.versionAdvisory).toMatchObject({
          canUpdate: true,
          latestVersion: unknown ? null : "1.2.0",
          status: unknown ? "unknown" : "behind_latest",
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("pins Grok npm updates to the selected prefix and requires its official package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* windowsFixture("no-ownership", "user", grokDefinition, "grok-cli");
      const locks = [];
      for (let index = 0; index < 2; index++) {
        const prefix = yield* fs.makeTempDirectoryScoped({ prefix: "t3 grok npm " });
        const shim = NodePath.join(prefix, "grok.cmd");
        NodeFS.writeFileSync(shim, "fixture");
        const unrelated = NodePath.join(prefix, "node_modules", "grok");
        NodeFS.mkdirSync(unrelated, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(unrelated, "package.json"), "{}");
        expect((yield* f.resolve(shim)).update).toBeNull();
        const official = NodePath.join(prefix, "node_modules", "@xai-official", "grok");
        NodeFS.mkdirSync(official, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(official, "package.json"), "{}");
        const capabilities = yield* f.resolve(shim);
        expect(capabilities.update).toMatchObject({
          executable: "npm",
          args: [
            "install",
            "-g",
            "--prefix",
            prefix,
            "--allow-scripts=@xai-official/grok",
            "@xai-official/grok@latest",
          ],
        });
        expect(capabilities.packageName).toBe("@xai-official/grok");
        expect(capabilities.latestVersion).toBeUndefined();
        locks.push(capabilities.update?.lockKey);
      }
      expect(locks[0]).not.toBe(locks[1]);
    }).pipe(Effect.scoped),
  );

  it.effect("fetches Grok npm versions and leaves native installs manual", () =>
    Effect.gen(function* () {
      const resolver = makePackageManagedProviderMaintenanceResolver(grokDefinition);
      const resolve = (commandPath: string) =>
        resolver.resolve({
          binaryPath: commandPath,
          resolvedCommandPath: commandPath,
          realCommandPath: commandPath,
          env: {},
          platform: "linux",
        });
      const capabilities = yield* resolve(
        "/opt/Node Tools/lib/node_modules/@xai-official/grok/bin/grok.js",
      );
      expect(capabilities.update?.executable).toBe("npm");
      const latest = yield* resolveLatestProviderVersion(capabilities).pipe(
        Effect.provideService(ProviderVersionCache, new Map()),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://registry.npmjs.org/%40xai-official%2Fgrok/latest");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ version: "1.3.0" })),
              ),
            );
          }),
        ),
      );
      expect(latest).toBe("1.3.0");
      expect((yield* resolve("/home/user/.local/bin/grok")).update).toBeNull();
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );
  it.effect("bounds the whole Windows resolution across sequential probes", () =>
    Effect.gen(function* () {
      const f = yield* windowsFixture("slow-probes");
      const fiber = yield* Effect.forkChild(f.resolve(f.wingetTarget));
      yield* Deferred.await(f.probeStarted);
      yield* TestClock.adjust("10 seconds");
      const result = fiber.pollUnsafe();
      expect(result && Exit.isSuccess(result)).toBe(true);
      if (result && Exit.isSuccess(result))
        expect(result.value).toMatchObject({ update: null, latestVersion: null });
    }).pipe(Effect.scoped),
  );

  for (const invalid of ["oversized", "invalid-utf8"]) {
    it.effect(`rejects ${invalid} Scoop metadata`, () =>
      Effect.gen(function* () {
        const f = yield* windowsFixture();
        NodeFS.writeFileSync(
          NodePath.join(f.current, "install.json"),
          invalid === "oversized"
            ? `{"bucket":"main","padding":"${"x".repeat(256 * 1024)}"}`
            : Buffer.concat([
                Buffer.from('{"bucket":"main","padding":"'),
                Buffer.from([0xff]),
                Buffer.from('"}'),
              ]),
        );
        expect((yield* f.resolve(f.shim)).update).toBeNull();
      }).pipe(Effect.scoped),
    );
  }

  for (const scope of ["user", "machine"]) {
    it.effect(`updates only the explicitly selected Scoop/WinGet installation (${scope})`, () =>
      Effect.gen(function* () {
        const f = yield* windowsFixture(scope === "machine" ? "global-config" : "", scope);
        const scoop = yield* f.resolve(f.shim);
        const winget = yield* f.resolve(f.wingetTarget);
        expect(scoop.update).toMatchObject({
          executable: f.manager,
          args: ["update", "main/package-tool", ...(scope === "machine" ? ["--global"] : [])],
          env: {
            ...f.env,
            ...(scope === "machine" ? { SCOOP_GLOBAL: f.root.replaceAll("\\", "/") } : {}),
            SCOOP: NodePath.dirname(NodePath.dirname(f.manager)).replaceAll("\\", "/"),
          },
        });
        expect(winget.update).toMatchObject({
          executable: f.winget,
          args: [
            "upgrade",
            "--id",
            "Example.PackageTool",
            "--exact",
            "--source",
            "private source",
            "--scope",
            scope,
            "--location",
            NodePath.dirname(f.wingetTarget),
            "--rename",
            "tool.exe",
            "--accept-source-agreements",
            "--disable-interactivity",
          ],
          env: f.env,
        });
        expect(scoop.update?.command).toContain("& '");
        expect(winget.update?.command).toContain("'private source'");
        expect(winget.update?.windowsInstaller).toEqual({ manager: "winget", scope });
        expect(scoop.update?.windowsInstaller).toEqual({ manager: "scoop", scope });
        expect(scoop.latestVersion).toBeNull();
        expect(yield* resolveLatestProviderVersion(winget)).toBe("1.2.0");
        expect(scoop.update?.lockKey).not.toBe(winget.update?.lockKey);
      }).pipe(Effect.provideService(HttpClient.HttpClient, noNpmRequest), Effect.scoped),
    );
  }

  it.effect("shares Scoop's lock across packages and user/global scope in the same manager", () =>
    Effect.gen(function* () {
      const f = yield* windowsFixture("", "machine");
      const userCurrent = NodePath.join(
        NodePath.dirname(NodePath.dirname(f.manager)),
        "apps",
        "other",
        "current",
      );
      NodeFS.mkdirSync(userCurrent, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(userCurrent, "install.json"), '{"bucket":"extras"}');
      const userTarget = NodePath.join(userCurrent, "other.exe");
      writeExecutable(userTarget);
      const global = yield* f.resolve(f.target);
      const user = yield* f.resolve(userTarget);
      expect(user.update).not.toBeNull();
      expect(user.update?.lockKey).toBe(global.update?.lockKey);
      expect(user.update?.args).toEqual(["update", "extras/other"]);
      const independent = yield* windowsFixture();
      expect((yield* independent.resolve(independent.target)).update?.lockKey).not.toBe(
        user.update?.lockKey,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("preserves a registered custom WinGet executable name and location", () =>
    Effect.gen(function* () {
      const f = yield* windowsFixture("renamed-install");
      const { update } = yield* f.resolve(f.wingetTarget);
      expect(update?.args).toEqual(
        expect.arrayContaining([
          "--rename",
          "custom tool.exe",
          "--location",
          NodePath.dirname(f.wingetTarget),
        ]),
      );
      expect(update?.command).toContain("'custom tool.exe'");
    }).pipe(Effect.scoped),
  );

  for (const [packageId, scope] of [
    ["OpenAI.Codex", "user"],
    ["SST.opencode", "machine"],
  ]) {
    it.effect.skipIf(!symlinksSupported)(
      `recognizes indexed ${packageId} aliases and direct selection (${scope})`,
      () =>
        Effect.gen(function* () {
          const f = yield* windowsFixture("archive", scope, {
            ...grokDefinition,
            wingetPackageId: packageId!,
          });
          const before = NodeFS.readFileSync(f.indexPath);
          for (const selected of [f.wingetLink, f.wingetTarget]) {
            const { update } = yield* f.resolve(selected);
            expect(update?.executable).toBe(f.winget);
            expect(update?.args).toEqual(
              expect.arrayContaining([
                "--id",
                packageId,
                "--scope",
                scope,
                "--location",
                NodePath.dirname(f.wingetTarget),
              ]),
            );
            expect(update?.args).not.toContain("--rename");
          }
          expect(NodeFS.readFileSync(f.indexPath)).toEqual(before);
          NodeFS.unlinkSync(f.wingetLink);
          NodeFS.symlinkSync(f.target, f.wingetLink);
          expect((yield* f.resolve(f.wingetTarget)).update).toBeNull();
          expect((yield* f.resolve(f.wingetLink)).update).toBeNull();
        }).pipe(Effect.scoped),
    );
  }

  for (const failure of ["missing", "corrupt", "wrong-target", "ambiguous"]) {
    it.effect(`refuses a WinGet archive with ${failure} index ownership`, () =>
      Effect.gen(function* () {
        const f = yield* windowsFixture("directory-install");
        if (failure === "missing") NodeFS.unlinkSync(f.indexPath);
        else if (failure === "corrupt") NodeFS.writeFileSync(f.indexPath, "not sqlite");
        else {
          const db = new NodeSqlite.DatabaseSync(f.indexPath);
          try {
            if (failure === "wrong-target")
              db.prepare("UPDATE portable SET symlinktarget = ? WHERE filetype = 3").run(f.target);
            else
              db.prepare("INSERT INTO portable VALUES (?, 3, '', ?)").run(
                f.wingetLink + "-other",
                f.wingetTarget,
              );
          } finally {
            db.close();
          }
        }
        expect((yield* f.resolve(f.wingetTarget)).update).toBeNull();
        if (failure === "missing") expect(NodeFS.existsSync(f.indexPath)).toBe(false);
      }).pipe(Effect.scoped),
    );
  }

  const scoopFailures = [
    "missing-shim",
    "duplicate-target",
    "foreign-target",
    "bad-metadata",
    "missing-manager",
    "wrong-global",
  ];
  for (const failure of [
    ...scoopFailures,
    "registry-failure",
    "registry-partial",
    "no-ownership",
    "wrong-target",
    "duplicate-install",
    "wrong-source",
    "duplicate-source",
  ]) {
    it.effect(`refuses unproven Windows ownership: ${failure}`, () =>
      Effect.gen(function* () {
        const f = yield* windowsFixture(failure, "machine");
        const scoopFailure = scoopFailures.includes(failure);
        expect((yield* f.resolve(scoopFailure ? f.shim : f.wingetTarget)).update).toBeNull();
      }).pipe(Effect.scoped),
    );
  }

  for (const mode of ["directory-install", "show-failure"]) {
    it.effect(`resolves WinGet ${mode} without falling back to npm versions`, () =>
      Effect.gen(function* () {
        const f = yield* windowsFixture(mode);
        const result = yield* f.resolve(f.wingetTarget);
        expect(result.update?.executable).toBe(f.winget);
        expect(yield* resolveLatestProviderVersion(result)).toBe(
          mode === "show-failure" ? null : "1.2.0",
        );
      }).pipe(Effect.provideService(HttpClient.HttpClient, noNpmRequest), Effect.scoped),
    );
  }

  it.effect.skipIf(!windowsHost && !symlinksSupported)(
    "follows Scoop current junctions and accepts direct selection",
    () =>
      Effect.gen(function* () {
        const f = yield* windowsFixture();
        const version = NodePath.join(NodePath.dirname(f.current), "1.0.0");
        NodeFS.renameSync(f.current, version);
        NodeFS.symlinkSync(version, f.current, windowsHost ? "junction" : "dir");
        expect((yield* f.resolve(f.shim)).update?.executable).toBe(f.manager);
        expect((yield* f.resolve(f.target)).update?.executable).toBe(f.manager);
        const pinned = NodePath.join(version, "tool.exe");
        expect((yield* f.resolve(pinned)).update).toBeNull();
        NodeFS.writeFileSync(f.shim.replace(/\.exe$/, ".shim"), `path = "${pinned}"`);
        expect((yield* f.resolve(f.shim)).update).toBeNull();
        const stale = NodePath.join(NodePath.dirname(f.current), "0.9.0", "tool.exe");
        NodeFS.mkdirSync(NodePath.dirname(stale));
        NodeFS.writeFileSync(stale, "old binary");
        expect((yield* f.resolve(stale)).update).toBeNull();
      }).pipe(Effect.scoped),
  );

  for (const failure of [
    "missing-uninstall",
    "missing-uninstall-empty",
    "missing-uninstall-present",
    "missing-uninstall-unreadable",
    "registry-failure",
  ]) {
    it.effect(`preserves proven npm ownership with inconclusive WinGet probes: ${failure}`, () =>
      Effect.gen(function* () {
        const f = yield* windowsFixture(failure);
        for (const segments of [
          [".local", "bin", "tool.exe"],
          ["npm", "tool.cmd"],
          ["shims", "tool.cmd"],
          ["apps", "node", "global", "tool.cmd"],
        ]) {
          const native = segments[0] === ".local";
          const binary = NodePath.join(NodePath.dirname(f.root), ...segments);
          writeExecutable(binary);
          if (!native) {
            const manifest = NodePath.join(
              NodePath.dirname(binary),
              "node_modules",
              "@example",
              "package-tool",
              "package.json",
            );
            NodeFS.mkdirSync(NodePath.dirname(manifest), { recursive: true });
            NodeFS.writeFileSync(manifest, '{"name":"@example/package-tool"}');
          }
          if (native) {
            const result = yield* f.resolve(binary);
            if (failure === "missing-uninstall" || failure === "missing-uninstall-empty")
              expect(result.update?.executable).toBe(binary);
            else expect(result.update).toBeNull();
          } else {
            const result = yield* resolveProviderMaintenanceCapabilitiesEffect(f.resolver, {
              binaryPath: binary,
              env: f.env,
            }).pipe(
              Effect.provideService(HostProcessPlatform, "win32"),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
            );
            expect(result.update).toMatchObject({
              executable: "npm",
              args: [
                "install",
                "-g",
                "--prefix",
                NodePath.dirname(binary),
                "--allow-scripts=@example/package-tool",
                "@example/package-tool@latest",
              ],
            });
            expect(result.latestVersion).toBeUndefined();
          }
        }
      }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!symlinksSupported)(
    "rejects a WinGet link retargeted to another installer",
    () =>
      Effect.gen(function* () {
        const f = yield* windowsFixture();
        const link = NodePath.join(NodePath.dirname(f.wingetTarget), "link.exe");
        NodeFS.symlinkSync(f.wingetTarget, link);
        expect((yield* f.resolve(link)).update?.executable).toBe(f.winget);
        NodeFS.unlinkSync(link);
        NodeFS.symlinkSync(f.target, link);
        expect((yield* f.resolve(link)).update).toBeNull();
      }).pipe(Effect.scoped),
  );

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
      const tempDir = NodePath.join(
        yield* makeTempDir("t3-npm-windows-capabilities"),
        "scoop",
        "apps",
        "nodejs-lts",
        "current",
      );
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

  it.effect("retries an interrupted resolution without poisoning the cache", () =>
    Effect.gen(function* () {
      let calls = 0;
      const started = yield* Deferred.make<void>();
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.suspend(() =>
          ++calls === 1
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(manualPackageTool),
        ),
      );
      const first = yield* Effect.forkChild(resolve());
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      expect(Exit.isSuccess(yield* Effect.exit(resolve()))).toBe(true);
      expect(calls).toBe(2);
    }),
  );

  it.effect("shares advisory work and re-resolves fresh requests queued behind it", () =>
    Effect.gen(function* () {
      let calls = 0;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const sharedRequested = yield* Deferred.make<void>();
      const freshRequested = yield* Deferred.make<void>();
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.gen(function* () {
          const version = String(++calls);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return { ...manualPackageTool, latestVersion: version };
        }),
      );
      const first = yield* Effect.forkChild(resolve());
      yield* Deferred.await(started);
      const shared = yield* Effect.forkChild(
        Deferred.succeed(sharedRequested, undefined).pipe(Effect.andThen(resolve())),
      );
      yield* Deferred.await(sharedRequested);
      const fresh = yield* Effect.forkChild(
        Deferred.succeed(freshRequested, undefined).pipe(Effect.andThen(resolve({ fresh: true }))),
      );
      yield* Deferred.await(freshRequested);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(first)).latestVersion).toBe("1");
      // Advisory readers may acquire the permit before or after the fresh reader.
      expect(["1", "2"]).toContain((yield* Fiber.join(shared)).latestVersion);
      expect((yield* Fiber.join(fresh)).latestVersion).toBe("2");
      expect(calls).toBe(2);
      expect((yield* resolve()).latestVersion).toBe("2");
      yield* TestClock.adjust("1 hour");
      expect((yield* resolve()).latestVersion).toBe("3");
    }),
  );
});
