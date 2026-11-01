// TEMPORARY one-time workaround for a Node --build-sea bug on Linux arm64.
// It breaks kernels with 16 KiB or 64 KiB pages. Revert when Node ships a fix.
// Node issue: https://github.com/nodejs/node/issues/67048
// Workaround PR: https://github.com/pingdotgg/t3code/pull/25825
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class LinuxArm64SeaError extends Schema.TaggedError<LinuxArm64SeaError>()("LinuxArm64SeaError", {
  message: Schema.String,
}) {}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const run = Effect.fn("LinuxArm64Sea.run")(function* (args: Array<string>, verbose: boolean) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, args, {
      stdout: verbose ? "inherit" : "ignore",
      stderr: "inherit",
    }),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new LinuxArm64SeaError({ message: `${args[0]} exited with code ${exitCode}.` });
  }
});

// Builds the SEA blob with this Node and injects it into a copy of this Node with postject.
export const injectLinuxArm64Sea = Effect.fn("LinuxArm64Sea.inject")(function* (input: {
  bundlePath: string;
  outputPath: string;
  nodeVersion: string;
  verbose: boolean;
}) {
  // The copied execPath is the shipped runtime; vp pack only checks its own Node.
  if (process.versions.node !== input.nodeVersion) {
    return yield* new LinuxArm64SeaError({
      message: `Linux ARM64 executables must be built with Node ${input.nodeVersion}; running ${process.versions.node}.`,
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sea-" });
  const blobPath = path.join(temp, "sea.blob");
  const configPath = path.join(temp, "sea.json");
  yield* fs.writeFileString(
    configPath,
    yield* encodeJson({
      main: input.bundlePath,
      output: blobPath,
      mainFormat: "module",
      disableExperimentalSEAWarning: true,
      // Node SEA useCodeCache breaks import(), which the server needs.
      useCodeCache: false,
    }),
  );
  yield* run(["--experimental-sea-config", configPath], input.verbose);
  yield* fs.copyFile(process.execPath, input.outputPath);
  yield* fs.chmod(input.outputPath, 0o755);
  const require = NodeModule.createRequire(import.meta.url);
  yield* run(
    [
      require.resolve("postject/dist/cli.js"),
      input.outputPath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    input.verbose,
  );
}, Effect.scoped);

// Kernels map LOAD segments in whole pages. Checking at 64 KiB covers 4, 16, and 64 KiB kernels.
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
