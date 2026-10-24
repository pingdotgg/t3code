import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeBinary } from "@tsdown/exe";

class CliSeaBuildError extends Schema.TaggedError<CliSeaBuildError>()("CliSeaBuildError", {
  message: Schema.String,
}) {}

const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const isLinuxArm64SeaTarget = Effect.fn("isLinuxArm64SeaTarget")(function* (
  target?: string,
) {
  return (
    (target || `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`) ===
    "linux-arm64"
  );
});

export function assertLinuxArm64PageCompatibility(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 64 ||
    view.getUint32(0, false) !== 0x7f454c46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    view.getUint16(18, true) !== 183
  ) {
    throw new Error("Expected a little-endian ELF64 ARM64 executable.");
  }
  const tableOffset = Number(view.getBigUint64(32, true));
  const entrySize = view.getUint16(54, true);
  const count = view.getUint16(56, true);
  if (
    !Number.isSafeInteger(tableOffset) ||
    entrySize < 56 ||
    count === 0 ||
    tableOffset + entrySize * count > bytes.length
  ) {
    throw new Error("Invalid ELF program header table.");
  }
  const pageSize = 0x10000n;
  const ranges: Array<{ start: bigint; end: bigint }> = [];
  for (let index = 0; index < count; index++) {
    const header = tableOffset + index * entrySize;
    if (view.getUint32(header, true) !== 1) continue;
    const offset = view.getBigUint64(header + 8, true);
    const address = view.getBigUint64(header + 16, true);
    const size = view.getBigUint64(header + 40, true);
    if (offset % pageSize !== address % pageSize) {
      throw new Error(`ARM64 LOAD segment ${index} is incompatible with 64 KiB pages.`);
    }
    if (size === 0n) continue;
    const start = address / pageSize;
    const end = (address + size + pageSize - 1n) / pageSize;
    if (ranges.some((range) => start < range.end && range.start < end)) {
      throw new Error(`ARM64 LOAD segments overlap on a 64 KiB page (segment ${index}).`);
    }
    ranges.push({ start, end });
  }
  if (ranges.length === 0) throw new Error("ELF executable has no LOAD segments.");
}

// Node 26.12.1's built-in injector relocates ARM64 segments on 4 KiB boundaries.
// Keep its security-fixed runtime and blob format, but use postject's ELF layout.
export const buildLinuxArm64Sea = Effect.fn("buildLinuxArm64Sea")(function* (input: {
  bundlePath: string;
  outputPath: string;
  nodeVersion: string;
  crossTarget: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (process.versions.node !== input.nodeVersion) {
    return yield* new CliSeaBuildError({
      message: `ARM64 SEA blobs must be built with Node ${input.nodeVersion}.`,
    });
  }
  const executable = input.crossTarget
    ? yield* Effect.tryPromise(() =>
        resolveNodeBinary({ platform: "linux", arch: "arm64", nodeVersion: input.nodeVersion }, {}),
      )
    : process.execPath;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sea-" });
  const blob = path.join(temp, "sea.blob");
  const config = path.join(temp, "sea.json");
  yield* fs.writeFileString(
    config,
    yield* encodeConfig({
      main: input.bundlePath,
      output: blob,
      mainFormat: "module",
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    }),
  );
  yield* runSeaCommand(["--experimental-sea-config", config]);
  yield* fs.copyFile(executable, input.outputPath);
  const require = NodeModule.createRequire(import.meta.url);
  yield* runSeaCommand([
    require.resolve("postject/dist/cli.js"),
    input.outputPath,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ]);
  const bytes = yield* fs.readFile(input.outputPath);
  yield* Effect.try(() => assertLinuxArm64PageCompatibility(bytes));
  yield* fs.chmod(input.outputPath, 0o755);
});

const runSeaCommand = Effect.fn("runSeaCommand")(function* (args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, args, {
      stdout: "ignore",
      stderr: "inherit",
    }),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new CliSeaBuildError({
      message: `SEA command ${args[0]} exited with code ${exitCode}.`,
    });
  }
});
