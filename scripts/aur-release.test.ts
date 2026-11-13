import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const run = Effect.fn("test.aur.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string | undefined>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd, env, extendEnv: false }),
  );
  const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (left, right) => left + right,
      ),
    );
  const [stdout, stderr, code] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, code };
}, Effect.scoped);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("AUR release", () => {
  it.live.each([
    { nightly: false, naming: "versioned", failure: undefined },
    { nightly: true, naming: "versioned", failure: undefined },
    { nightly: false, naming: "versionless", failure: undefined },
    { nightly: true, naming: "versionless", failure: undefined },
    { nightly: false, naming: "versioned", failure: "missing" },
    { nightly: false, naming: "versioned", failure: "digest" },
    { nightly: false, naming: "versioned", failure: "version" },
  ])("updates architecture-specific sources: %j", ({ nightly, naming, failure }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inherited = yield* HostProcess.Environment;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-aur-release-" });
      const aur = path.join(root, "packaging/aur");
      yield* fs.copy(path.join(import.meta.dirname, "../packaging/aur"), aur);
      const tools = path.join(root, "tools");
      yield* fs.makeDirectory(tools);
      for (const [name, source] of Object.entries({
        gh: '#!/bin/bash\nif [[ "$*" == *releases/tags/* ]]; then cat "$AUR_FIXTURE_RELEASE"; else echo "fixture license"; fi\n',
        id: "#!/bin/sh\necho 1000\n",
        namcap: "#!/bin/sh\nexit 0\n",
        makepkg: '#!/bin/sh\nif [ "$1" = --packagelist ]; then echo fixture.pkg.tar.zst; fi\n',
      })) {
        const file = path.join(tools, name);
        yield* fs.writeFileString(file, source);
        yield* fs.chmod(file, 0o755);
      }
      const version = nightly ? "1.2.4-nightly.20261104.1" : "1.2.3";
      const pkgname = nightly ? "t3code-nightly-bin" : "t3code-bin";
      const prefix =
        naming === "versioned" ? `T3-Code-${version}` : nightly ? "T3-Code-Nightly" : "T3-Code";
      const assets = [
        { name: `${prefix}-x86_64.AppImage`, digest: `sha256:${"a".repeat(64)}` },
        ...(failure === "missing"
          ? []
          : [
              {
                name:
                  failure === "version"
                    ? "T3-Code-1.2.2-arm64.AppImage"
                    : `${prefix}-arm64.AppImage`,
                digest: failure === "digest" ? "invalid" : `sha256:${"b".repeat(64)}`,
              },
            ]),
      ];
      const fixture = path.join(root, "release.json");
      yield* fs.writeFileString(fixture, JSON.stringify({ assets }));
      const packageDir = path.join(aur, pkgname);
      const recipe = path.join(packageDir, "PKGBUILD");
      const before = yield* fs.readFileString(recipe);
      const env = {
        PATH: `${tools}:${inherited.PATH}`,
        RELEASE_TAG: `v${version}`,
        AUR_FIXTURE_RELEASE: fixture,
        AUR_SSH_PRIVATE_KEY: "",
      };
      const result = yield* run("bash", [path.join(aur, "scripts/release.sh")], root, env);
      if (failure) {
        assert.notEqual(Number(result.code), 0, result.stdout + result.stderr);
        assert.equal(yield* fs.readFileString(recipe), before);
        return;
      }
      assert.equal(Number(result.code), 0, result.stdout + result.stderr);
      for (const [arch, upstreamArch, checksum] of [
        ["x86_64", "x86_64", "a"],
        ["aarch64", "arm64", "b"],
      ] as const) {
        const selected = yield* run(
          "bash",
          [
            "-c",
            `source PKGBUILD
          declare -n sources="source_$CARCH" sums="sha256sums_$CARCH"
          printf '%s\\n' "$pkgver" "\${arch[*]}" "\${sources[@]}" "\${sums[@]}" "$_appimage"`,
          ],
          packageDir,
          { ...env, CARCH: arch },
        );
        assert.equal(Number(selected.code), 0, selected.stderr);
        const localName = `T3-Code-${version}-${upstreamArch}.AppImage`;
        assert.deepEqual(selected.stdout.trim().split("\n"), [
          version.replace("-nightly.", "_nightly."),
          "x86_64 aarch64",
          `${localName}::https://github.com/pingdotgg/t3code/releases/download/v${version}/${prefix}-${upstreamArch}.AppImage`,
          checksum.repeat(64),
          localName,
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
