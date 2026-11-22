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

import { CLI_RELEASE_METADATA_FILE, npmReleaseDatabaseMigration } from "@t3tools/shared/cliRelease";

import { buildNpmLauncher } from "./build-npm-launcher.ts";
import { buildReleaseMetadata } from "./build-release-metadata.ts";

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

const serveFakeRelease = Effect.fn("test.serveFakeRelease")(function* (
  root: string,
  executable = `#!/bin/sh
if [ -n "$T3CODE_TEST_CALLS" ]; then echo "$*|$T3CODE_NPM_LAUNCHER_PATH" >> "$T3CODE_TEST_CALLS"; fi
if [ "$1" = "--version" ]; then echo "${VERSION}"; exit 0; fi
echo "stub $* launcher=$T3CODE_NPM_LAUNCHER_PATH"
exit 7
`,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const stem = `t3-${VERSION}-${key}`;
  const archiveName = `${stem}.tar.gz`;
  yield* fs.makeDirectory(path.join(root, "release", stem, "node_modules/native"), {
    recursive: true,
  });
  yield* fs.writeFileString(path.join(root, "release", stem, "t3"), executable);
  yield* fs.chmod(path.join(root, "release", stem, "t3"), 0o755);
  const tar = yield* run("tar", ["-czf", archiveName, stem], {
    cwd: path.join(root, "release"),
    env: { PATH: (yield* HostProcess.Environment).PATH },
  });
  assert.equal(tar.exitCode, 0, tar.stderr);
  const archive = yield* fs.readFile(path.join(root, "release", archiveName));
  let checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const requests: Array<string> = [];
  const failures: Array<number> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    const url = new URL(request.url ?? "", "http://localhost");
    const prefix = url.pathname.startsWith("/mirror/") ? "/mirror" : "";
    const failure = failures.shift();
    if (failure !== undefined) {
      response.writeHead(failure).end("upstream timed out");
    } else if (prefix && url.search !== "?region=test") {
      response.writeHead(400).end();
    } else if (url.pathname === `${prefix}/v${VERSION}/SHA256SUMS`) {
      response.end(`${checksum}  ${archiveName}\n`);
    } else if (url.pathname === `${prefix}/v${VERSION}/${archiveName}`) {
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
    failNextRequests: (...statuses: Array<number>) => {
      failures.push(...statuses);
    },
  };
});

it.layer(NodeServices.layer)("build-npm-launcher", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes a launcher that downloads, verifies, caches, and runs the release executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // macOS temp directories sit under /var, a link to /private/var, and the launcher
        // reports the resolved path it runs from.
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-launcher-test-" }),
        );
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });

        const manifest = yield* decodeManifest(
          yield* fs.readFileString(path.join(output.packageDir, "package.json")),
        );
        assert.equal(manifest.name, "t3");
        assert.equal(manifest.version, VERSION);
        assert.deepStrictEqual(manifest.bin, { t3: "./bin/t3.mjs" });
        assert.isUndefined(manifest.dependencies);
        assert.isUndefined(manifest.optionalDependencies);
        assert.isAbove(npmReleaseDatabaseMigration(manifest) ?? 0, 0);

        const metadataPath = yield* buildReleaseMetadata({
          version: VERSION,
          outputDir: path.join(root, "assets"),
        });
        assert.equal(path.basename(metadataPath), CLI_RELEASE_METADATA_FILE);
        assert.deepStrictEqual(yield* decodeManifest(yield* fs.readFileString(metadataPath)), {
          version: VERSION,
          databaseMigration: npmReleaseDatabaseMigration(manifest),
        });

        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: (yield* HostProcess.Environment).PATH },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);
        const packageDir = path.join(installed, "package");

        const diagnosticHook = path.join(root, "diagnostic-hook.mjs");
        for (const status of [404, 403, 0]) {
          yield* fs.writeFileString(
            diagnosticHook,
            `globalThis.fetch = async (url) => {
              if (url !== "https://mirror-user:mirror-pass@mirror.example/releases/v${VERSION}/SHA256SUMS?signature=test-secret#download") throw new Error("wrong request");
              if (${status} === 0) throw new Error("transport signature=test-secret mirror-pass");
              return new Response("", { status: ${status} });
            };`,
          );
          const failed = yield* run(
            process.execPath,
            ["--import", diagnosticHook, path.join(packageDir, "bin/t3.mjs")],
            {
              cwd: root,
              env: {
                PATH: (yield* HostProcess.Environment).PATH,
                T3CODE_HOME: path.join(root, `failed-${status}`),
                T3CODE_RELEASE_BASE_URL:
                  "https://mirror-user:mirror-pass@mirror.example/releases/?signature=test-secret#download",
              },
            },
          );
          assert.equal(failed.exitCode, 1);
          assert.include(failed.stderr, `https://mirror.example/releases/v${VERSION}/SHA256SUMS`);
          assert.include(
            failed.stderr,
            status === 404 ? "does not exist" : status === 403 ? "HTTP 403" : "failed to connect",
          );
          for (const secret of [
            "mirror-user",
            "mirror-pass",
            "signature",
            "test-secret",
            "#download",
          ]) {
            assert.notInclude(failed.stdout + failed.stderr, secret);
          }
        }

        const release = yield* serveFakeRelease(root);
        // regression: #32897
        release.failNextRequests(504, 524);
        const home = path.join(root, "home");
        const env = {
          PATH: (yield* HostProcess.Environment).PATH,
          T3CODE_HOME: home,
          T3CODE_TEST_CALLS: path.join(root, "calls"),
          T3CODE_RELEASE_BASE_URL: `${release.baseUrl}/mirror///?region=test#download`,
        };
        const launcher = yield* fs.realPath(path.join(packageDir, "bin/t3.mjs"));
        const first = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env,
        });
        assert.equal(first.stdout.trim(), `stub serve a b launcher=${launcher}`, first.stderr);
        assert.equal(first.exitCode, 7);
        assert.deepStrictEqual(
          (yield* fs.readFileString(env.T3CODE_TEST_CALLS)).trim().split("\n"),
          ["--version|", `serve a b|${launcher}`],
        );
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

        // Two transient failures, then the retry that succeeds.
        assert.deepStrictEqual(release.requests, [
          `/mirror/v${VERSION}/SHA256SUMS?region=test`,
          `/mirror/v${VERSION}/SHA256SUMS?region=test`,
          `/mirror/v${VERSION}/SHA256SUMS?region=test`,
          `/mirror/v${VERSION}/t3-${VERSION}-${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}.tar.gz?region=test`,
        ]);
        const requestsAfterFirst = release.requests.length;
        const second = yield* run(process.execPath, [launcher, "--version"], { cwd: root, env });
        assert.equal(second.exitCode, 0);
        assert.equal(release.requests.length, requestsAfterFirst);
        assert.deepStrictEqual(
          (yield* fs.readFileString(env.T3CODE_TEST_CALLS)).trim().split("\n"),
          ["--version|", `serve a b|${launcher}`, `--version|${launcher}`],
        );

        yield* fs.writeFileString(path.join(versionDir, "t3"), "#!/t3-test-missing-loader\n");
        for (const _attempt of [1, 2]) {
          const cached = yield* run(process.execPath, [launcher, "serve"], { cwd: root, env });
          assert.equal(cached.exitCode, 1, cached.stderr);
          assert.include(cached.stderr, "could not run");
          assert.equal(release.requests.length, requestsAfterFirst);
          assert.equal(
            yield* fs.readFileString(path.join(versionDir, ".install-complete")),
            `${VERSION}\n`,
          );
        }

        const forkReleaseHook = path.join(root, "fork-release.mjs");
        yield* fs.writeFileString(
          forkReleaseHook,
          `const fetchRelease = globalThis.fetch;
const prefix = "https://github.com/ScriptedAlchemy/t3code/releases/download";
globalThis.fetch = (input, options) => {
  const url = String(input);
  if (!url.startsWith(prefix + "/")) throw new Error("Unexpected release URL: " + url);
  return fetchRelease(${JSON.stringify(release.baseUrl)} + url.slice(prefix.length), options);
};\n`,
        );
        const defaultRelease = yield* run(
          process.execPath,
          ["--import", forkReleaseHook, launcher, "--version"],
          {
            cwd: root,
            env: {
              PATH: (yield* HostProcess.Environment).PATH,
              T3CODE_HOME: path.join(root, "fork-home"),
            },
          },
        );
        assert.equal(defaultRelease.exitCode, 0, defaultRelease.stderr);
        assert.equal(defaultRelease.stdout.trim(), VERSION);

        const unsupportedHook = path.join(root, "unsupported-platform.mjs");
        yield* fs.writeFileString(
          unsupportedHook,
          'Object.defineProperty(process, "platform", { value: "darwin" });\nObject.defineProperty(process, "arch", { value: "x64" });\n',
        );
        const unsupported = yield* run(
          process.execPath,
          ["--import", unsupportedHook, launcher, "--version"],
          { cwd: root, env },
        );
        assert.equal(unsupported.exitCode, 1);
        assert.include(unsupported.stderr, "no T3 Code CLI build is available for darwin-x64");
        assert.include(unsupported.stderr, "https://github.com/ScriptedAlchemy/t3code/releases");

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
        assert.equal(one.exitCode, 0, one.stderr);
        assert.equal(two.exitCode, 0, two.stderr);
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
        assert.equal(replaced.stdout.trim(), VERSION, replaced.stderr);
        assert.equal(replaced.exitCode, 0);
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
    "kills a runtime that ignores the forwarded SIGTERM, and its providers, so the launcher exits",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-launcher-test-" });
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });
        const hostPath = (yield* HostProcess.Environment).PATH;
        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: hostPath },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);

        const home = path.join(root, "home");
        const versionDir = path.join(home, "runtime/versions", VERSION);
        yield* fs.makeDirectory(versionDir, { recursive: true });
        yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${VERSION}\n`);
        // Stands in for a runtime whose exit is stuck behind blocked filesystem calls, with a
        // provider it never gets to stop. Both give up on their own well inside the project
        // timeout so an unescalated stop fails descriptively.
        const stuck = "runtime ignored SIGTERM and was still running 30s later";
        const orphaned = "provider outlived the runtime by 30s";
        const provider = `process.on("SIGTERM", () => {}); setTimeout(() => { console.log(${JSON.stringify(orphaned)}); process.exit(0); }, 30_000);`;
        yield* fs.writeFileString(
          path.join(versionDir, "t3"),
          `#!${process.execPath}
const provider = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(provider)}], { stdio: "inherit" });
process.on("SIGTERM", () => setTimeout(() => { console.log(${JSON.stringify(stuck)}); process.exit(0); }, 30_000));
setInterval(() => {}, 1 << 30);
console.log(process.pid, provider.pid);
`,
        );
        yield* fs.chmod(path.join(versionDir, "t3"), 0o755);

        const launcher = NodeChildProcess.spawn(
          process.execPath,
          [path.join(installed, "package/bin/t3.mjs"), "serve"],
          { cwd: root, env: { PATH: hostPath, T3CODE_HOME: home }, stdio: "pipe" },
        );
        let pids: Array<number> = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of [...pids, launcher.pid]) {
              try {
                if (pid !== undefined) process.kill(pid, "SIGKILL");
              } catch {}
            }
          }),
        );
        let stdout = "";
        const started = Promise.withResolvers<void>();
        launcher.stdout.setEncoding("utf8");
        launcher.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("\n")) started.resolve();
        });
        // The runtime and provider inherit this pipe, so it closes only once all three are gone.
        const closed = NodeEvents.EventEmitter.once(launcher.stdout, "close");
        yield* Effect.promise(() => started.promise);
        pids = stdout.trim().split(" ").map(Number);
        assert.isTrue(pids.length === 2 && pids.every(Number.isInteger), stdout);

        launcher.kill("SIGTERM");
        yield* Effect.promise(() => closed);
        assert.notInclude(stdout, stuck, "the launcher waited on a runtime that ignored SIGTERM");
        assert.notInclude(stdout, orphaned, "the runtime's provider outlived the launcher");
      }),
  );
});

for (const { name, executable } of [
  { name: "missing loader", executable: "#!/t3-test-missing-loader\n" },
  {
    name: "loader failure",
    executable: '#!/bin/sh\necho "runtime loader failed" >&2\nexit 42\n',
  },
  { name: "terminated probe", executable: "#!/bin/sh\nkill -TERM $$\n" },
  {
    name: "unresponsive probe",
    executable: `#!/bin/sh
trap 'echo caught > "$T3CODE_TEST_TERM"; exit 42' TERM
mkfifo "$T3CODE_TEST_READY.fifo" || exit 1
exec 3<>"$T3CODE_TEST_READY.fifo"
echo ready > "$T3CODE_TEST_READY"
read -r unused <&3
`,
  },
]) {
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    `does not publish an unusable release: ${name}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-validation-test-" });
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });
        const release = yield* serveFakeRelease(root, executable);
        const home = path.join(root, "home");
        const dir = path.join(home, "runtime/versions", VERSION);
        const env = {
          PATH: (yield* HostProcess.Environment).PATH,
          T3CODE_HOME: home,
          T3CODE_RELEASE_BASE_URL: release.baseUrl,
          T3CODE_TEST_READY: path.join(root, "probe-ready"),
          T3CODE_TEST_TERM: path.join(root, "probe-term"),
        };
        const launcher = path.join(output.packageDir, "bin/t3.mjs");
        const failed = yield* run(process.execPath, [launcher, "serve"], { cwd: root, env });
        assert.equal(failed.exitCode, 1, failed.stderr);
        assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(dir)), [], failed.stderr);
        assert.include(failed.stderr, "could not run");
        if (executable.includes("runtime loader failed")) {
          assert.include(failed.stderr, "runtime loader failed");
        }
        if (name === "terminated probe") assert.include(failed.stderr, "SIGTERM");
        if (name === "unresponsive probe") {
          assert.isTrue(yield* fs.exists(env.T3CODE_TEST_READY), failed.stderr);
          assert.isFalse(yield* fs.exists(env.T3CODE_TEST_TERM));
          assert.include(failed.stderr, "ETIMEDOUT");
        }
        if ((yield* HostProcess.Platform) === "linux") {
          assert.include(failed.stderr, "glibc");
          assert.include(failed.stderr, "musl");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}
