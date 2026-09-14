import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildNpmPlatformPackages,
  NpmPackagesArchivesMissingError,
} from "./build-npm-platform-packages.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const KEYS = ["linux-x64", "darwin-arm64"] as const;

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
  options: { readonly cwd: string; readonly env?: Record<string, string> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env ?? {} }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

/** A tar.gz laid out like build-cli-archive.ts writes, with a stub `t3` that echoes its args. */
const makeFakeArchives = Effect.fn("test.makeFakeArchives")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-packages-test-" });
  const archivesDir = path.join(root, "archives");
  yield* fs.makeDirectory(archivesDir);
  for (const key of KEYS) {
    const stem = `t3-${VERSION}-${key}`;
    const stage = path.join(root, "stage", key);
    const contentDir = path.join(stage, stem);
    for (const dir of ["client", "resource-monitor", "node_modules/node-pty"]) {
      yield* fs.makeDirectory(path.join(contentDir, dir), { recursive: true });
    }
    yield* fs.writeFileString(path.join(contentDir, "client/index.html"), "<html></html>\n");
    yield* fs.writeFileString(
      path.join(contentDir, "t3"),
      `#!/bin/sh\necho "stub ${key} $*"\nexit 7\n`,
    );
    yield* fs.chmod(path.join(contentDir, "t3"), 0o755);
    const exit = yield* run("tar", ["-czf", path.join(archivesDir, `${stem}.tar.gz`), stem], {
      cwd: stage,
    });
    assert.equal(exit.exitCode, 0, exit.stderr);
  }
  yield* fs.writeFileString(path.join(archivesDir, "SHA256SUMS"), "");
  return { root, archivesDir, outputDir: path.join(root, "out") };
});

it.layer(NodeServices.layer)("build-npm-platform-packages", (it) => {
  it.effect("refuses a partial release unless --allow-missing is passed", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFakeArchives();
      const error = yield* buildNpmPlatformPackages({
        ...fixture,
        version: VERSION,
        allowMissing: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, NpmPackagesArchivesMissingError);
      assert.deepStrictEqual((error as NpmPackagesArchivesMissingError).missing, [
        "linux-arm64",
        "win32-arm64",
        "win32-x64",
      ]);
    }),
  );

  it.effect("builds platform packages and a launcher that execs the installed one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFakeArchives();
      const outputs = yield* buildNpmPlatformPackages({
        ...fixture,
        version: VERSION,
        allowMissing: true,
      });
      // Platform packages in CLI_ARCHIVE_PLATFORM_KEYS order, launcher last.
      assert.deepStrictEqual(
        outputs.map((output) => output.name),
        ["@t3code/t3-darwin-arm64", "@t3code/t3-linux-x64", "t3"],
      );
      for (const output of outputs) {
        assert.isTrue(yield* fs.exists(output.tarball), output.tarball);
      }

      const linuxDir = path.join(fixture.outputDir, "@t3code/t3-linux-x64");
      const linuxManifest = yield* decodeManifest(
        yield* fs.readFileString(path.join(linuxDir, "package.json")),
      );
      assert.equal(linuxManifest.name, "@t3code/t3-linux-x64");
      assert.equal(linuxManifest.version, VERSION);
      assert.deepStrictEqual(linuxManifest.os, ["linux"]);
      assert.deepStrictEqual(linuxManifest.cpu, ["x64"]);
      assert.deepStrictEqual(linuxManifest.files, [
        "t3",
        "t3.exe",
        "client",
        "resource-monitor",
        "node_modules",
      ]);
      assert.equal(linuxManifest.preferUnplugged, true);
      assert.isUndefined(linuxManifest.bin);
      // Archive contents sit at the package root, not under the archive stem.
      assert.isTrue(yield* fs.exists(path.join(linuxDir, "client/index.html")));
      // A root README, or npm would display a bundled dependency's.
      assert.include(
        yield* fs.readFileString(path.join(linuxDir, "README.md")),
        "# @t3code/t3-linux-x64",
      );
      assert.isTrue(yield* fs.exists(path.join(linuxDir, "node_modules/node-pty")));
      assert.equal(Number((yield* fs.stat(path.join(linuxDir, "t3"))).mode) & 0o111, 0o111);

      const darwinManifest = yield* decodeManifest(
        yield* fs.readFileString(
          path.join(fixture.outputDir, "@t3code/t3-darwin-arm64/package.json"),
        ),
      );
      assert.deepStrictEqual(darwinManifest.os, ["darwin"]);
      assert.deepStrictEqual(darwinManifest.cpu, ["arm64"]);

      const launcherDir = path.join(fixture.outputDir, "t3");
      const launcherManifest = yield* decodeManifest(
        yield* fs.readFileString(path.join(launcherDir, "package.json")),
      );
      assert.equal(launcherManifest.name, "t3");
      assert.equal(launcherManifest.version, VERSION);
      assert.deepStrictEqual(launcherManifest.bin, { t3: "./bin/t3.js" });
      assert.deepStrictEqual(launcherManifest.files, ["bin", "dist"]);
      assert.deepStrictEqual(launcherManifest.optionalDependencies, {
        "@t3code/t3-darwin-arm64": VERSION,
        "@t3code/t3-linux-x64": VERSION,
      });
      assert.isUndefined(launcherManifest.engines);
      assert.isTrue(yield* fs.exists(path.join(launcherDir, "bin/t3.js")));

      // The scratch dirs must not be left behind next to the packages.
      const outputEntries = yield* fs.readDirectory(fixture.outputDir);
      assert.deepStrictEqual(outputEntries.sort(), ["@t3code", "t3", "t3.tgz"]);

      // The tarball is what gets published: it must carry node_modules (which
      // `npm publish <dir>` would strip) under npm's `package/` root, with the
      // executable bit intact.
      const listing = yield* run(
        "tar",
        ["-tzvf", path.join(fixture.outputDir, "@t3code/t3-linux-x64.tgz")],
        { cwd: fixture.outputDir },
      );
      assert.equal(listing.exitCode, 0, listing.stderr);
      const lines = listing.stdout.split("\n");
      assert.isTrue(lines.some((line) => line.endsWith(" package/node_modules/node-pty/")));
      assert.isTrue(lines.some((line) => line.endsWith(" package/package.json")));
      assert.isTrue(
        lines.some((line) => /^-rwxr-xr-x .* package\/t3$/.test(line)),
        listing.stdout,
      );

      // NODE_PATH stands in for node_modules: require.resolve finds the
      // platform package there exactly as it would after `npm install`.
      const hostPlatform = yield* HostProcessPlatform;
      const hostArch = yield* HostProcessArchitecture;
      const env = { ...process.env, NODE_PATH: fixture.outputDir } as Record<string, string>;
      const passthrough = yield* run(process.execPath, ["bin/t3.js", "serve", "--port", "1234"], {
        cwd: launcherDir,
        env,
      });
      assert.equal(passthrough.stdout.trim(), `stub ${hostPlatform}-${hostArch} serve --port 1234`);
      assert.equal(passthrough.exitCode, 7);

      // Run the entry point used by already-installed service updaters from
      // the published tarball, including their preflight arguments.
      const installedLauncher = path.join(fixture.root, "installed-launcher");
      yield* fs.makeDirectory(installedLauncher);
      const unpack = yield* run(
        "tar",
        ["-xf", path.join(fixture.outputDir, "t3.tgz"), "-C", installedLauncher],
        {
          cwd: fixture.root,
        },
      );
      assert.equal(unpack.exitCode, 0, unpack.stderr);
      const legacy = yield* run(
        process.execPath,
        [
          "dist/bin.mjs",
          "__service-preflight",
          "--database-path",
          "a database.sqlite",
          "--launcher-protocol",
          "2",
        ],
        { cwd: path.join(installedLauncher, "package"), env },
      );
      assert.equal(
        legacy.stdout.trim(),
        `stub ${hostPlatform}-${hostArch} __service-preflight --database-path a database.sqlite --launcher-protocol 2`,
      );
      assert.equal(legacy.exitCode, 7);

      const unsupported = yield* run(process.execPath, ["bin/t3.js", "--version"], {
        cwd: launcherDir,
        env: { ...env, NODE_PATH: path.join(fixture.root, "nowhere") },
      });
      assert.equal(unsupported.exitCode, 1);
      assert.include(unsupported.stderr, "linux-x64");
      assert.include(unsupported.stderr, "win32-arm64");
      assert.include(unsupported.stderr, "https://github.com/pingdotgg/t3code/releases");
    }),
  );
});
