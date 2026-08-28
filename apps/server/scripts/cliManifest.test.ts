import * as NodeProcess from "node:process";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import serverPackageJson from "../package.json" with { type: "json" };
import { createServerCliPublishPackageJson } from "./cliManifest.ts";

const RESOURCE_MONITOR_EXECUTABLES = [
  "dist/resource-monitor/darwin-arm64/t3-resource-monitor",
  "dist/resource-monitor/darwin-x64/t3-resource-monitor",
  "dist/resource-monitor/linux-arm64/t3-resource-monitor",
  "dist/resource-monitor/linux-x64/t3-resource-monitor",
];
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function readTarField(header: Uint8Array, start: number, end: number): string {
  const field = header.subarray(start, end);
  const nullOffset = field.indexOf(0);
  return field
    .subarray(0, nullOffset === -1 ? field.length : nullOffset)
    .toString()
    .trim();
}

function readTarModes(tarball: Uint8Array): ReadonlyMap<string, number> {
  const archive = NodeZlib.gunzipSync(tarball);
  const modes = new Map<string, number>();

  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarField(header, 0, 100);
    const modeText = readTarField(header, 100, 108);
    const sizeText = readTarField(header, 124, 136);
    const mode = Number.parseInt(modeText, 8);
    const size = Number.parseInt(sizeText, 8);

    modes.set(name, mode & 0o777);
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return modes;
}

describe("CLI publish manifest", () => {
  it("marks POSIX resource monitors as executable", () => {
    assert.deepStrictEqual(
      serverPackageJson.publishConfig.executableFiles,
      RESOURCE_MONITOR_EXECUTABLES,
    );
  });

  it("retains executable file metadata in the generated publish manifest", () => {
    const manifest = createServerCliPublishPackageJson({
      source: { ...serverPackageJson, dependencies: {} },
      version: "1.2.3",
      workspaceCatalog: {},
      workspaceOverrides: {},
    });

    assert.deepStrictEqual(manifest.publishConfig.executableFiles, RESOURCE_MONITOR_EXECUTABLES);
  });

  it.effect("packs every POSIX resource monitor with executable mode", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-pack-",
      });
      const outputDir = path.join(fixtureDir, "packed");

      yield* fileSystem.makeDirectory(outputDir);
      yield* fileSystem.writeFileString(
        path.join(fixtureDir, "package.json"),
        encodeUnknownJson({
          name: "t3-resource-monitor-pack-fixture",
          version: "1.0.0",
          packageManager: "pnpm@11.10.0",
          files: ["dist"],
          publishConfig: serverPackageJson.publishConfig,
        }),
      );

      for (const executable of RESOURCE_MONITOR_EXECUTABLES) {
        const executablePath = path.join(fixtureDir, executable);
        yield* fileSystem.makeDirectory(path.dirname(executablePath), { recursive: true });
        yield* fileSystem.writeFileString(executablePath, "fixture\n");
        yield* fileSystem.chmod(executablePath, 0o644);
      }

      const vpExecutable = path.resolve(
        import.meta.dirname,
        "../../../node_modules/vite-plus/bin/vp",
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(
          NodeProcess.execPath,
          [vpExecutable, "pm", "pack", "--pack-destination", outputDir],
          {
            cwd: fixtureDir,
            stdout: "inherit",
            stderr: "inherit",
          },
        ),
      );
      assert.equal(yield* child.exitCode, 0);

      const [tarballName] = yield* fileSystem.readDirectory(outputDir);
      assert.ok(tarballName);
      const modes = readTarModes(yield* fileSystem.readFile(path.join(outputDir, tarballName)));
      for (const executable of RESOURCE_MONITOR_EXECUTABLES) {
        assert.equal(modes.get(`package/${executable}`), 0o755, executable);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
