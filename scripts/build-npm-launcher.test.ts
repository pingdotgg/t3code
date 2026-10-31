// @effect-diagnostics nodeBuiltinImport:off - Serves a fake GitHub Release over real HTTP to the published launcher.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";

import { npmReleaseDatabaseMigration } from "@t3tools/shared/cliRelease";

import { buildNpmLauncher } from "./build-npm-launcher.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: false }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

const serveFakeRelease = Effect.fn("test.serveFakeRelease")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const stem = `t3-${VERSION}-${key}`;
  const archiveName = `${stem}.tar.gz`;
  yield* fs.makeDirectory(path.join(root, "release", stem, "node_modules/native"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(root, "release", stem, "t3"),
    '#!/bin/sh\necho "stub $* launcher=$T3CODE_NPM_LAUNCHER_PATH"\nexit 7\n',
  );
  yield* fs.chmod(path.join(root, "release", stem, "t3"), 0o755);
  const tar = yield* run("tar", ["-czf", archiveName, stem], {
    cwd: path.join(root, "release"),
    env: { PATH: process.env.PATH },
  });
  assert.equal(tar.exitCode, 0, tar.stderr);
  const archive = yield* fs.readFile(path.join(root, "release", archiveName));
  let checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const requests: Array<string> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === `/v${VERSION}/SHA256SUMS`) {
      response.end(`${checksum}  ${archiveName}\n`);
    } else if (request.url === `/v${VERSION}/${archiveName}`) {
      response.writeHead(200, { "Content-Length": archive.length }).end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* Effect.die("no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    corruptChecksum: () => {
      checksum = "0".repeat(64);
    },
  };
});

const unpackLauncher = Effect.fn("test.unpackLauncher")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* buildNpmLauncher({ version: VERSION, outputDir: path.join(root, "out") });
  const installed = path.join(root, "installed");
  yield* fs.makeDirectory(installed);
  const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
    cwd: root,
    env: { PATH: process.env.PATH },
  });
  assert.equal(unpack.exitCode, 0, unpack.stderr);
  return { output, packageDir: path.join(installed, "package") };
});

it.layer(NodeServices.layer)("build-npm-launcher", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes a launcher that downloads, verifies, caches, and runs the release executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-launcher-test-" });
        const { output, packageDir } = yield* unpackLauncher(root);

        const manifest = yield* decodeManifest(
          yield* fs.readFileString(path.join(output.packageDir, "package.json")),
        );
        assert.equal(manifest.name, "t3");
        assert.equal(manifest.version, VERSION);
        assert.deepStrictEqual(manifest.bin, { t3: "./bin/t3.mjs" });
        assert.isUndefined(manifest.dependencies);
        assert.isUndefined(manifest.optionalDependencies);
        assert.isAbove(npmReleaseDatabaseMigration(manifest) ?? 0, 0);

        const release = yield* serveFakeRelease(root);
        const home = path.join(root, "home");
        const env = {
          PATH: process.env.PATH,
          T3CODE_HOME: home,
          T3CODE_RELEASE_BASE_URL: release.baseUrl,
        };
        const launcher = path.join(packageDir, "bin/t3.mjs");
        const first = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env,
        });
        assert.equal(first.stdout.trim(), `stub serve a b launcher=${launcher}`, first.stderr);
        assert.equal(first.exitCode, 7);
        const versionDir = path.join(home, "runtime/versions", VERSION);
        assert.equal(
          (yield* fs.readFileString(path.join(versionDir, ".install-complete"))).trim(),
          VERSION,
        );
        assert.isTrue(yield* fs.exists(path.join(versionDir, "node_modules/native")));
        assert.deepStrictEqual(
          (yield* fs.readDirectory(path.join(home, "runtime/versions"))).sort(),
          [VERSION],
        );

        const requestsAfterFirst = release.requests.length;
        const second = yield* run(process.execPath, [launcher, "--version"], { cwd: root, env });
        assert.equal(second.exitCode, 7);
        assert.equal(release.requests.length, requestsAfterFirst);

        const ipcServer = path.join(home, "runtime/versions", VERSION, "t3");
        yield* fs.writeFileString(
          ipcServer,
          `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(23));\nprocess.on("message", (m) => process.send({ reply: m }));\nprocess.send({ args: process.argv.slice(2) });\n`,
        );
        const legacy = NodeChildProcess.fork(
          path.join(packageDir, "dist/bin.mjs"),
          ["__service-preflight", "a b"],
          { env, silent: true },
        );
        yield* Effect.promise(async () => {
          assert.deepStrictEqual((await NodeEvents.EventEmitter.once(legacy, "message"))[0], {
            args: ["__service-preflight", "a b"],
          });
          const reply = NodeEvents.EventEmitter.once(legacy, "message");
          legacy.send({ type: "trial-accepted" });
          assert.deepStrictEqual((await reply)[0], { reply: { type: "trial-accepted" } });
          const exit = NodeEvents.EventEmitter.once(legacy, "exit");
          legacy.kill("SIGTERM");
          assert.deepStrictEqual(await exit, [23, null]);
        });

        const raceHome = path.join(root, "race-home");
        const launch = run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: raceHome },
        });
        const [one, two] = yield* Effect.all([launch, launch], { concurrency: "unbounded" });
        assert.equal(one.exitCode, 7, one.stderr);
        assert.equal(two.exitCode, 7, two.stderr);
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(raceHome, "runtime/versions")), [
          VERSION,
        ]);

        // A peer's executable and sidecar stay available after every later rename or removal,
        // even when it publishes after our missing-marker read.
        const staleHome = path.join(root, "stale-home");
        const staleDir = path.join(staleHome, "runtime/versions", VERSION);
        const peerDir = path.join(root, "peer-runtime");
        yield* fs.makeDirectory(staleDir, { recursive: true });
        yield* fs.writeFileString(path.join(staleDir, "t3"), "");
        yield* fs.makeDirectory(peerDir);
        yield* fs.writeFileString(path.join(peerDir, "t3"), '#!/bin/sh\necho "peer $*"\nexit 7\n');
        yield* fs.chmod(path.join(peerDir, "t3"), 0o755);
        yield* fs.writeFileString(path.join(peerDir, ".install-complete"), `${VERSION}\n`);
        yield* fs.writeFileString(path.join(peerDir, "sidecar"), "peer sidecar");
        const peerChecks = path.join(root, "peer-checks.txt");
        // The peer publishes after the launcher's rename fails and it reads the marker.
        const peerHook = path.join(root, "peer-publishes.mjs");
        yield* fs.writeFileString(
          peerHook,
          `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const dir = ${JSON.stringify(staleDir)};
const { readFileSync, renameSync, rmSync } = fs;
let checking = false;
let published = false;
const checkPeer = () => {
  const child = spawnSync(dir + "/t3", ["--version"], { encoding: "utf8" });
  let sidecar;
  try {
    sidecar = readFileSync(dir + "/sidecar", "utf8");
  } catch (error) {
    sidecar = error.code;
  }
  fs.appendFileSync(${JSON.stringify(peerChecks)},
    [child.status, child.error?.code ?? child.stdout.trim(), sidecar].join("|") + "\\n");
};
fs.renameSync = (from, to) => {
  try {
    return renameSync(from, to);
  } catch (error) {
    checking ||= to === dir;
    throw error;
  } finally {
    if (published) checkPeer();
  }
};
fs.rmSync = (...args) => {
  try {
    return rmSync(...args);
  } finally {
    if (published) checkPeer();
  }
};
fs.readFileSync = (file, ...rest) => {
  try {
    return readFileSync(file, ...rest);
  } finally {
    if (checking && file === dir + "/.install-complete") {
      checking = false;
      rmSync(dir, { recursive: true });
      renameSync(${JSON.stringify(peerDir)}, dir);
      published = true;
      checkPeer();
    }
  }
};
`,
        );
        const recovered = yield* run(
          process.execPath,
          ["--import", peerHook, launcher, "--version"],
          { cwd: root, env: { ...env, T3CODE_HOME: staleHome } },
        );
        const checks = (yield* fs.readFileString(peerChecks)).trim().split("\n");
        assert.isAtLeast(checks.length, 2);
        assert.deepStrictEqual([...new Set(checks)], ["7|peer --version|peer sidecar"]);
        assert.equal(recovered.stdout.trim(), "peer --version", recovered.stderr);
        assert.equal(recovered.exitCode, 7);
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(staleHome, "runtime/versions")), [
          VERSION,
        ]);

        // While another launch holds the lock, a stale folder is left alone and the error says
        // how to clear a lock left by a crash.
        const staleOnlyHome = path.join(root, "stale-only-home");
        const staleOnlyDir = path.join(staleOnlyHome, "runtime/versions", VERSION);
        yield* fs.makeDirectory(staleOnlyDir, { recursive: true });
        yield* fs.writeFileString(path.join(staleOnlyDir, "t3"), "incomplete");
        yield* fs.makeDirectory(`${staleOnlyDir}.lock`);
        const locked = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: staleOnlyHome },
        });
        assert.equal(locked.exitCode, 1);
        assert.include(locked.stderr, `delete ${staleOnlyDir}.lock`);
        assert.equal(yield* fs.readFileString(path.join(staleOnlyDir, "t3")), "incomplete");

        // Without a peer, the stale folder is replaced by our own download.
        yield* fs.remove(`${staleOnlyDir}.lock`, { recursive: true });
        const replaced = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: staleOnlyHome },
        });
        assert.equal(
          replaced.stdout.trim(),
          `stub --version launcher=${launcher}`,
          replaced.stderr,
        );
        assert.equal(replaced.exitCode, 7);
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(staleOnlyHome, "runtime/versions")),
          [VERSION],
        );

        release.corruptChecksum();
        const corrupt = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: path.join(root, "other-home") },
        });
        assert.equal(corrupt.exitCode, 1);
        assert.include(corrupt.stderr, "checksum mismatch");
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(root, "other-home/runtime/versions")),
          [],
        );
      }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "runs an installed t3 at least as new as its own version instead of npm's",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-launcher-test-" });
        const { packageDir } = yield* unpackLauncher(root);
        const release = yield* serveFakeRelease(root);
        const home = path.join(root, "home");
        const env = {
          PATH: process.env.PATH,
          T3CODE_HOME: home,
          T3CODE_RELEASE_BASE_URL: release.baseUrl,
        };
        const launcher = path.join(packageDir, "bin/t3.mjs");
        const installAs = Effect.fn("test.installAs")(function* (version: string) {
          const dir = path.join(home, "runtime/versions", version);
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(
            path.join(dir, "t3"),
            `#!/bin/sh\necho "installed ${version} $* launcher=$T3CODE_NPM_LAUNCHER_PATH"\nexit 5\n`,
          );
          yield* fs.chmod(path.join(dir, "t3"), 0o755);
          yield* fs.writeFileString(path.join(dir, ".install-complete"), `${version}\n`);
          const link = path.join(root, "bin", "t3");
          yield* fs.makeDirectory(path.dirname(link), { recursive: true });
          yield* fs.remove(link, { force: true });
          yield* fs.symlink(path.join(dir, "t3"), link);
          yield* fs.writeFileString(path.join(home, "runtime/launchers"), `${link}\n`);
        });

        yield* installAs("1.2.4-nightly.20261026.1");
        const newer = yield* run(process.execPath, [launcher, "connect"], { cwd: root, env });
        assert.equal(newer.stdout.trim(), "installed 1.2.4-nightly.20261026.1 connect launcher=");
        assert.equal(newer.exitCode, 5);
        assert.deepStrictEqual(release.requests, []);

        const optedOut = yield* run(process.execPath, [launcher, "connect"], {
          cwd: root,
          env: { ...env, T3CODE_USE_NPM: "1" },
        });
        assert.equal(optedOut.stdout.trim(), `stub connect launcher=${launcher}`, optedOut.stderr);

        yield* fs.chmod(path.join(home, "runtime/versions/1.2.4-nightly.20261026.1/t3"), 0o644);
        const brokenInstall = yield* run(process.execPath, [launcher, "connect"], {
          cwd: root,
          env,
        });
        assert.equal(brokenInstall.stdout.trim(), `stub connect launcher=${launcher}`);

        // An install that passes every check but cannot start falls back to npm's copy once.
        const installedExe = path.join(home, "runtime/versions/1.2.4-nightly.20261026.1/t3");
        for (const content of ["\x7fELF\x02\x01\x01garbage", "#!/no/such/interpreter\n"]) {
          yield* fs.writeFileString(installedExe, content);
          yield* fs.chmod(installedExe, 0o755);
          const cannotStart = yield* run(process.execPath, [launcher, "connect"], {
            cwd: root,
            env,
          });
          assert.equal(cannotStart.stdout.trim(), `stub connect launcher=${launcher}`, content);
          assert.equal(cannotStart.exitCode, 7);
        }

        // Signals stop that fallback while it downloads, instead of going to the dead child.
        yield* fs.remove(path.join(home, "runtime/versions", VERSION), { recursive: true });
        const requested = Promise.withResolvers<void>();
        const hanging = NodeHttp.createServer(() => requested.resolve());
        yield* Effect.acquireRelease(
          Effect.callback<void>((resume) => {
            hanging.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () =>
            Effect.callback<void>((resume) => {
              hanging.closeAllConnections();
              hanging.close(() => resume(Effect.void));
            }),
        );
        const address = hanging.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die("no TCP address");
        }
        const downloading = NodeChildProcess.spawn(process.execPath, [launcher, "serve"], {
          env: { ...env, T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}` },
          stdio: "ignore",
        });
        const stopped = yield* Effect.promise(async () => {
          const exited = NodeEvents.EventEmitter.once(downloading, "exit");
          await requested.promise;
          downloading.kill("SIGTERM");
          return exited;
        });
        assert.deepStrictEqual(stopped, [null, "SIGTERM"]);

        // Pre-0.0.41 services re-enter over IPC and must keep npm's exact version.
        yield* installAs("1.2.4-nightly.20261026.1");
        const service = NodeChildProcess.fork(launcher, ["__service-preflight"], {
          env,
          silent: true,
        });
        const serviceOutput = yield* Effect.promise(async () => {
          let output = "";
          service.stdout?.on("data", (chunk) => (output += chunk));
          await NodeEvents.EventEmitter.once(service, "exit");
          return output;
        });
        assert.equal(serviceOutput.trim(), `stub __service-preflight launcher=${launcher}`);

        yield* installAs("1.2.3-nightly.20261026.1");
        const older = yield* run(process.execPath, [launcher, "connect"], { cwd: root, env });
        assert.equal(older.stdout.trim(), `stub connect launcher=${launcher}`, older.stderr);

        const desktopShim = path.join(home, "bin", "t3");
        const desktopApp = path.join(root, "T3 Code's app");
        yield* fs.makeDirectory(path.dirname(desktopShim), { recursive: true });
        yield* fs.writeFileString(
          desktopShim,
          `#!/bin/sh\n# T3 Code version: ${VERSION}\napp='${desktopApp.replaceAll("'", `'"'"'`)}'\necho "desktop $*"\nexit 6\n`,
        );
        yield* fs.chmod(desktopShim, 0o755);
        const removedApp = yield* run(process.execPath, [launcher, "connect"], { cwd: root, env });
        assert.equal(
          removedApp.stdout.trim(),
          `stub connect launcher=${launcher}`,
          removedApp.stderr,
        );

        yield* fs.writeFileString(desktopApp, "");
        const notExecutable = yield* run(process.execPath, [launcher, "connect"], {
          cwd: root,
          env,
        });
        assert.equal(notExecutable.stdout.trim(), `stub connect launcher=${launcher}`);

        // A replaced (maybe older) app until the app runs again and refreshes its shim.
        yield* fs.chmod(desktopApp, 0o755);
        const replaced = yield* run(process.execPath, [launcher, "connect"], { cwd: root, env });
        assert.equal(replaced.stdout.trim(), `stub connect launcher=${launcher}`);

        // Any utimes moves the shim's ctime to now, which is what the launcher compares.
        yield* fs.utimes(desktopShim, 1_800_000_000, 1_800_000_000);
        const desktop = yield* run(process.execPath, [launcher, "connect"], { cwd: root, env });
        assert.equal(desktop.stdout.trim(), "desktop connect", desktop.stderr);
      }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
    "on Windows, runs the exe a recorded t3.cmd names, or npm's copy with the opt-out",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-launcher-win-" });
        const launcher = path.join(root, "pkg", "bin", "t3.mjs");
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.copyFile(path.join(import.meta.dirname, "npm-launcher", "t3.mjs"), launcher);
        yield* fs.writeFileString(
          path.join(root, "pkg", "package.json"),
          JSON.stringify({ name: "t3", version: VERSION }),
        );
        // A real executable stands in for the installed t3.exe; it prints the user name.
        const home = path.join(root, "home");
        const installed = path.join(home, "runtime", "versions", "1.2.4");
        yield* fs.makeDirectory(installed, { recursive: true });
        yield* fs.copyFile(
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
          path.join(installed, "t3.exe"),
        );
        yield* fs.writeFileString(path.join(installed, ".install-complete"), "1.2.4\n");
        const shim = path.join(root, "bin", "t3.cmd");
        yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
        yield* fs.writeFileString(shim, `@echo off\r\n"${path.join(installed, "t3.exe")}" %*`);
        yield* fs.writeFileString(path.join(home, "runtime", "launchers"), `${shim}\r\n`);

        const launch = (env: Record<string, string>) =>
          NodeChildProcess.spawnSync(process.execPath, [launcher], {
            encoding: "utf8",
            env: {
              ...process.env,
              T3CODE_HOME: home,
              // Any download attempt fails fast, so only the installed exe can succeed.
              T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:9",
              ...env,
            },
          });
        const user = process.env.USERNAME?.toLowerCase() ?? "";
        const deferred = launch({});
        assert.equal(deferred.status, 0, deferred.stderr);
        assert.include(deferred.stdout.toLowerCase(), user);

        const optedOut = launch({ T3CODE_USE_NPM: "1" });
        assert.notEqual(optedOut.status, 0);
        assert.notInclude(optedOut.stdout.toLowerCase(), user);
      }),
  );
});
