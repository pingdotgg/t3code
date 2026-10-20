import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ModelManifest from "./ModelManifest.ts";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexInstallation from "./CodexInstallation.ts";

const archive = Buffer.from(
  "H4sIAAAAAAAC/+3W0W6DIBQGYB/FcD0sKNSkD7J7aom6tmAQtzXL3n3QZM3qdWVt+n8XoCckJp78wLY3q8bu9Ge2HBbUUp7nYD4H8s9zrNdSsCxnWQLT6JULn8ye09K9h/u2/c0/jSM9xqGzo0+bf3Gdf15WQiD/Kdy61/CA+z8dlO9Wrv2387+c5Z9VZY38p7BY0+Gh8t/sVauLt9Ga9Pnnop7ln1e4/6fxRQ7qZCf/qt3YW0M2OX/JyfvljbCCy3XBSaiGH9VqH4tKuaZbC6qG4aDpTrmP3sQV2nh3Gmxvzqsud0vyjaABAAAAAAAAAAAAAAAk8gOq19rvACgAAA==",
  "base64",
);
const asset = {
  version: "0.156.1",
  target: "aarch64-apple-darwin",
  url: "https://github.com/openai/codex/releases/download/test/package.tar.gz",
  archiveBytes: archive.length,
};
const makeHarness = Effect.fn("test.makeCodexInstallation")(function* (
  input: {
    options?: Partial<CodexInstallation.CodexInstallationOptions>;
    manifestCurrent?: Effect.Effect<ModelManifest.ModelManifestData>;
    body?: Stream.Stream<Uint8Array>;
    baseDir?: string;
    local?: { version: string; appServerFails?: boolean; versionFails?: boolean };
    platform?: NodeJS.Platform;
    spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
    runtimeRenameFailures?: number;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir =
    input.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" }));
  const localDirectory = `${baseDir}/local`;
  const localBinaryPath = `${localDirectory}/codex${input.platform === "win32" ? ".exe" : ""}`;
  const probeLog = `${baseDir}/local-probes.txt`;
  if (input.local) {
    yield* fs.makeDirectory(localDirectory, { recursive: true });
    yield* fs.writeFileString(
      localBinaryPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${probeLog}'\ncase "$1" in\n--version) ${input.local.versionFails ? "exit 1" : `printf '%s\\n' 'codex-cli ${input.local.version}'`};;\napp-server) exit ${input.local.appServerFails ? "1" : "0"};;\nesac\n`,
      { mode: 0o755 },
    );
  }
  let downloads = 0;
  const crypto = yield* Crypto.Crypto;
  const sha256 = Hex.encode(yield* crypto.digest("SHA-256", archive).pipe(Effect.orDie));
  let runtimeRenameFailures = input.runtimeRenameFailures ?? 0;
  const failedRenames = yield* Queue.unbounded<void>();
  const lockingFs: FileSystem.FileSystem = {
    ...fs,
    // Suspended so each retry of the same effect is a fresh attempt, like the real rename.
    rename: (from, to) =>
      Effect.suspend(() =>
        /[/\\]runtime$/u.test(from) && runtimeRenameFailures-- > 0
          ? Queue.offer(failedRenames, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: from,
                  }),
                ),
              ),
            )
          : fs.rename(from, to),
      ),
  };
  const spawner = input.spawner ?? (yield* ChildProcessSpawner.ChildProcessSpawner);
  const installation = yield* CodexInstallation.makeCodexInstallation({
    baseDir,
    releaseAsset: { ...asset, sha256 },
    validate: () => Effect.void,
    ...input.options,
  }).pipe(
    Effect.provideService(ModelManifest.ModelManifest, {
      current: input.manifestCurrent ?? Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refreshInBackground: Effect.void,
    }),
    Effect.provideService(HostProcess.Platform, input.platform ?? "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
    Effect.provideService(HostProcess.Environment, {
      PATH: input.local ? localDirectory : "",
      SystemRoot: "C:\\Windows",
    }),
    Effect.provideService(FileSystem.FileSystem, lockingFs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          downloads++;
          return Object.defineProperty(
            HttpClientResponse.fromWeb(request, new Response(null)),
            "stream",
            {
              value: input.body ?? Stream.succeed(archive),
            },
          );
        }),
      ),
    ),
  );
  return {
    installation,
    fs,
    baseDir,
    localBinaryPath,
    probeLog,
    failedRenames,
    downloads: () => downloads,
  };
});
const terminalState = (installation: CodexInstallation.CodexInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect.each(["0.156.0", "0.156.1", "0.156.2", "0.157.0"])(
  "reuses installed Codex %s without downloading or taking ownership of it",
  (version) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ local: { version } });
      expect(yield* h.installation.start).toMatchObject({
        source: "local",
        phase: "succeeded",
        installedVersion: version,
        executablePath: h.localBinaryPath,
        canRemove: false,
      });
      expect(yield* h.installation.resolve()).toMatchObject({
        source: "local",
        executablePath: h.localBinaryPath,
        managedVersionDirectory: null,
        version,
      });
      yield* h.installation.acquire().pipe(Effect.scoped);
      expect(h.downloads()).toBe(0);
      expect(yield* h.fs.exists(h.installation.managedDirectory)).toBe(false);
      expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
        "--version",
        "app-server --help",
      ]);
      yield* h.installation.remove();
      expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
      expect((yield* h.installation.state).source).toBe("local");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect.each([
  { version: "0.128.9" },
  { version: "0.145.0" },
  { version: "0.155.1" },
  { version: "0.155.9" },
  { version: "0.156.1-alpha.1" },
  { version: "unknown" },
  { version: "0.156.1", appServerFails: true },
  { version: "0.156.1", versionFails: true },
])("downloads the pinned release when the local CLI is unsupported or broken: %j", (local) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local });
    expect((yield* h.installation.state).installedVersion).toBeNull();
    yield* h.installation.start;
    const installed = yield* terminalState(h.installation);
    expect(installed.phase).toBe("succeeded");
    const executable = yield* h.installation.resolve();
    expect(executable.source).toBe("managed");
    expect(installed.executablePath).toBe(executable.executablePath);
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("falls back to a managed download when the reused local executable disappears", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    expect((yield* h.installation.resolve()).source).toBe("local");
    yield* h.fs.remove(h.localBinaryPath);
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const compileNative = Effect.fn("test.compileNative")(function* (
  executablePath: string,
  source: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const compiler = yield* spawner.spawn(
    ChildProcess.make("cc", ["-x", "c", "-", "-o", executablePath], {
      stdin: Stream.make(new TextEncoder().encode(source)),
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  expect(yield* compiler.exitCode).toBe(0);
}, Effect.scoped);

it.effect.each([
  { withHost: false, marker: null },
  { withHost: true, marker: null },
  { withHost: false, marker: ".bunx" },
  { withHost: false, marker: ".shim" },
])("requires the native host or a known package-manager launcher: %j", ({ withHost, marker }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      local: { version: "0.156.1" },
      platform: marker ? "win32" : "darwin",
    });
    yield* compileNative(
      h.localBinaryPath,
      `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("codex-cli 0.156.1");
    return 0;
  }
  return !(argc == 3 && strcmp(argv[1], "app-server") == 0 && strcmp(argv[2], "--help") == 0);
}
`,
    );
    if (withHost) {
      const packageDirectory = `${h.baseDir}/package`;
      yield* h.fs.makeDirectory(packageDirectory);
      yield* h.fs.rename(h.localBinaryPath, `${packageDirectory}/codex`);
      yield* h.fs.copyFile(`${packageDirectory}/codex`, `${packageDirectory}/codex-code-mode-host`);
      yield* h.fs.symlink(`${packageDirectory}/codex`, h.localBinaryPath);
    }
    if (marker) {
      yield* h.fs.writeFileString(
        h.localBinaryPath.replace(/\.exe$/u, marker),
        "launcher metadata",
      );
    }
    const reusesLocal = withHost || marker !== null;
    const started = yield* h.installation.start;
    if (reusesLocal) {
      expect(started).toMatchObject({
        source: "local",
        phase: "succeeded",
        executablePath: h.localBinaryPath,
      });
    }
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe(reusesLocal ? "local" : "managed");
    expect(h.downloads()).toBe(reusesLocal ? 0 : 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rechecks compatibility after the local executable is replaced", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    expect((yield* h.installation.resolve()).source).toBe("local");
    yield* h.fs.remove(h.localBinaryPath);
    yield* h.fs.writeFileString(h.localBinaryPath, "#!/bin/sh\nprintf 'codex-cli 0.128.9\\n'\n", {
      mode: 0o755,
    });
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rechecks a cached local executable when the shared manifest policy changes", () =>
  Effect.gen(function* () {
    let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
    const h = yield* makeHarness({
      local: { version: "0.156.0" },
      manifestCurrent: Effect.sync(() => manifest),
    });
    expect((yield* h.installation.resolve()).source).toBe("local");
    manifest = {
      ...manifest,
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=0.0.42",
          ranges: [
            { range: ">=0.156.1", status: "supported" },
            { range: "<0.156.1", status: "broken" },
          ],
        },
      ],
    };
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
    expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
      "--version",
      "app-server --help",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses bundled Codex compatibility when the remote manifest omits its policy", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      local: { version: "0.156.0" },
      manifestCurrent: Effect.succeed({
        ...ModelManifest.BUNDLED_MODEL_MANIFEST,
        compatibility: [],
      }),
    });
    expect((yield* h.installation.start).source).toBe("local");
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { kind: "script", name: "volta-shim" },
  { kind: "native", name: "volta-shim" },
  { kind: "native", name: "mise" },
  { kind: "native", name: "aqua-proxy" },
])("preserves the invoked name of $kind $name launcher symlinks", ({ kind, name }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    const launcher = `${h.baseDir}/${name}`;
    if (kind === "native") {
      const payload = `${h.baseDir}/codex.js`;
      yield* h.fs.rename(h.localBinaryPath, payload);
      yield* compileNative(
        launcher,
        `#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *name = strrchr(argv[0], '/');
  if (strcmp(name ? name + 1 : argv[0], "codex") != 0) return 1;
  execv(${JSON.stringify(payload)}, argv);
  return 1;
}
`,
      );
    } else {
      yield* h.fs.writeFileString(
        launcher,
        '#!/bin/sh\ncase "$0" in */codex) ;; *) exit 1;; esac\ncase "$1" in --version) printf "codex-cli 0.156.1\\n";; app-server) exit 0;; esac\n',
        { mode: 0o755 },
      );
      yield* h.fs.remove(h.localBinaryPath);
    }
    yield* h.fs.symlink(launcher, h.localBinaryPath);
    expect(yield* h.installation.start).toMatchObject({ source: "local", phase: "succeeded" });
    expect((yield* h.installation.resolve()).executablePath).toBe(h.localBinaryPath);
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "installs the complete verified package in tools/codex/version and survives a restart",
  () =>
    Effect.gen(function* () {
      const { installation, fs, baseDir } = yield* makeHarness();
      yield* installation.start;
      expect((yield* terminalState(installation)).phase).toBe("succeeded");
      const executable = yield* installation.resolve();
      expect(executable.executablePath).toBe(`${baseDir}/tools/codex/0.156.1/bin/codex`);
      expect(
        yield* fs.readFileString(`${executable.managedVersionDirectory}/bin/codex-code-mode-host`),
      ).toBe("host");
      expect(yield* fs.readFileString(`${executable.managedVersionDirectory}/codex-path/rg`)).toBe(
        "rg",
      );
      const restarted = yield* makeHarness({ baseDir });
      expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("requires an update before running an older activated managed installation", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start;
    yield* terminalState(first.installation);
    const executable = yield* first.installation.resolve();
    const oldDirectory = `${first.installation.managedDirectory}/0.155.1`;
    yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
    for (const name of ["codex-package.json", ".install-complete.json"]) {
      const file = `${oldDirectory}/${name}`;
      yield* first.fs.writeFileString(
        file,
        (yield* first.fs.readFileString(file)).replaceAll("0.156.1", "0.155.1"),
      );
    }
    yield* first.fs.writeFileString(
      `${first.installation.managedDirectory}/active.json`,
      '{"version":"0.155.1"}',
    );
    const restarted = yield* makeHarness({ baseDir: first.baseDir });
    expect((yield* Effect.flip(restarted.installation.resolve())).detail).toContain(
      "outside the supported range",
    );
    yield* restarted.installation.start;
    expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
    expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    expect(restarted.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects corrupted downloads without publishing a runtime", () =>
  Effect.gen(function* () {
    const { installation, fs } = yield* makeHarness({
      options: { releaseAsset: { ...asset, sha256: "0".repeat(64) } },
    });
    yield* installation.start;
    const state = yield* terminalState(installation);
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("SHA-256");
    expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
    expect(yield* fs.exists(`${installation.managedDirectory}/0.156.1`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancels an in-flight download and cleans the staging directory", () =>
  Effect.gen(function* () {
    const downloading = yield* Deferred.make<void>();
    const body = Stream.fromEffect(
      Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const { installation, fs } = yield* makeHarness({ body });
    const started = yield* installation.start;
    yield* Deferred.await(downloading);
    expect((yield* installation.cancel(started.operationId!)).phase).toBe("cancelled");
    expect(
      (yield* fs.readDirectory(installation.managedDirectory)).filter((name) =>
        name.startsWith(".install-"),
      ),
    ).toEqual([]);
    expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("protects active process leases and removes the runtime after release", () =>
  Effect.gen(function* () {
    const { installation, fs } = yield* makeHarness();
    yield* installation.start;
    yield* terminalState(installation);
    const leaseScope = yield* Scope.make();
    yield* installation.acquire().pipe(Effect.provideService(Scope.Scope, leaseScope));
    expect((yield* Effect.flip(installation.remove())).detail).toContain("Stop Codex sessions");
    yield* Scope.close(leaseScope, Exit.void);
    yield* installation.remove();
    expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
    expect((yield* installation.state).installedVersion).toBeNull();
    expect((yield* installation.state).executablePath).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps an activated runtime when a later update fails verification", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start;
    yield* terminalState(first.installation);
    const update = yield* makeHarness({
      baseDir: first.baseDir,
      options: { releaseAsset: { ...asset, version: "0.156.2", sha256: "0".repeat(64) } },
    });
    expect((yield* update.installation.state).executablePath).toBe(
      (yield* first.installation.resolve()).executablePath,
    );
    yield* update.installation.start;
    expect((yield* terminalState(update.installation)).phase).toBe("failed");
    expect((yield* update.installation.resolve()).version).toBe("0.156.1");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("publishes complete packages for all supported platforms", () => {
  for (const platform of ["darwin", "linux", "win32"] as const)
    for (const arch of ["x64", "arm64"])
      expect(CodexInstallation.resolveCodexReleaseAsset(platform, arch)?.url).toContain(
        "codex-package-",
      );
  expect(CodexInstallation.resolveCodexReleaseAsset("linux", "riscv64")).toBeNull();
});
// Live clock: staleness compares real filesystem mtimes.
it.live("startup removes only stale staging directories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" });
    const managed = `${baseDir}/tools/codex`;
    const stale = ((yield* Clock.currentTimeMillis) - 25 * 60 * 60_000) / 1000;
    for (const name of [".install-stale", ".active-stale", ".install-live"]) {
      yield* fs.makeDirectory(`${managed}/${name}`, { recursive: true });
    }
    yield* fs.utimes(`${managed}/.install-stale`, stale, stale);
    yield* fs.utimes(`${managed}/.active-stale`, stale, stale);
    const h = yield* makeHarness({ baseDir });
    expect(yield* fs.readDirectory(managed)).toEqual([".install-live"]);
    expect((yield* h.installation.state).canRemove).toBe(true);

    yield* fs.remove(`${managed}/.install-live`, { recursive: true });
    yield* fs.makeDirectory(`${managed}/.install-stale`);
    yield* fs.utimes(`${managed}/.install-stale`, stale, stale);
    const fresh = yield* makeHarness({ baseDir });
    expect(yield* fs.readDirectory(managed)).toEqual([]);
    expect((yield* fresh.installation.state).canRemove).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const processHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
const windowsPackage: Record<string, string> = {
  "bin/codex.exe": "codex",
  "bin/codex-code-mode-host.exe": "host",
  "codex-path/rg.exe": "rg",
  "codex-package.json": JSON.stringify({
    layoutVersion: 1,
    version: asset.version,
    target: asset.target,
    entrypoint: "bin/codex.exe",
  }),
};
// Stands in for Windows' bsdtar: CRLF listings, and extraction writes the Windows layout.
const makeWindowsTar = (fs: FileSystem.FileSystem, commands: Array<string>) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const { command: executable, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push(executable);
      const names = Object.keys(windowsPackage);
      if (args[0] === "-tzf") return processHandle(`${names.join("\r\n")}\r\n`);
      if (args[0] === "-tvzf")
        return processHandle(`${names.map((name) => `-rwxr-xr-x 0 0 ${name}`).join("\r\n")}\r\n`);
      const runtime = args[3] ?? "";
      for (const [name, contents] of Object.entries(windowsPackage)) {
        yield* fs.makeDirectory(`${runtime}/${name.split("/").slice(0, -1).join("/")}`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${runtime}/${name}`, contents);
      }
      return processHandle("");
    }).pipe(Effect.orDie),
  );

it.effect("installs on Windows via System32 tar with CRLF output and a locked runtime", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const commands: Array<string> = [];
    const h = yield* makeHarness({
      platform: "win32",
      spawner: makeWindowsTar(fs, commands),
      runtimeRenameFailures: 3,
    });
    yield* h.installation.start;
    // Each failed attempt has scheduled its retry before the test fiber resumes.
    for (let attempt = 0; attempt < 3; attempt++) {
      yield* Queue.take(h.failedRenames);
      yield* TestClock.adjust("100 millis");
    }
    expect(yield* terminalState(h.installation)).toMatchObject({ phase: "succeeded" });
    expect(commands).toEqual([
      "C:\\Windows\\System32\\tar.exe",
      "C:\\Windows\\System32\\tar.exe",
      "C:\\Windows\\System32\\tar.exe",
    ]);
    const path = yield* Path.Path;
    expect((yield* h.installation.resolve()).executablePath).toBe(
      path.join(h.baseDir, "tools", "codex", "0.156.1", "bin", "codex.exe"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("does not retry a failed runtime rename outside Windows", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ runtimeRenameFailures: 1 });
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("failed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
