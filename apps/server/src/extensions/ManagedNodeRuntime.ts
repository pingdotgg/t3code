import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import { ExtensionError } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";

export const NODE_VERSION = "26.12.1";
// Pinned from https://nodejs.org/dist/v26.12.1/SHASUMS256.txt, reviewed with runtime updates.
const archives: Readonly<Record<string, { suffix: string; sha256: string }>> = {
  "darwin-arm64": {
    suffix: "tar.gz",
    sha256: "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
  },
  "darwin-x64": {
    suffix: "tar.gz",
    sha256: "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
  },
  "linux-arm64": {
    suffix: "tar.gz",
    sha256: "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
  },
  "linux-x64": {
    suffix: "tar.gz",
    sha256: "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
  },
  "win-arm64": {
    suffix: "zip",
    sha256: "34567581ee63967b37afb6b7a0cc63a2d550a43d5d838adb75982d7e356f2e2c",
  },
  "win-x64": {
    suffix: "zip",
    sha256: "b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4",
  },
};
const failure = (detail: string) =>
  new ExtensionError({ operation: "runtime", id: "node", reason: "install-failed", detail });
const installLock = Semaphore.makeUnsafe(1);
const isExtensionError = Schema.is(ExtensionError);

export const ensure = Effect.fn("ManagedNodeRuntime.ensure")(function* (baseDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const key = `${platform === "win32" ? "win" : platform}-${arch}`;
  const archive = archives[key];
  if (!archive)
    return yield* new ExtensionError({
      operation: "runtime",
      id: key,
      reason: "install-failed",
      detail: "No managed Node.js runtime is available for this platform.",
    });
  const name = `node-v${NODE_VERSION}-${key}`;
  const directory = path.join(baseDirectory, name);
  const paths = (root: string) => ({
    node: path.join(root, platform === "win32" ? "node.exe" : "bin/node"),
    npm: path.join(
      root,
      platform === "win32"
        ? "node_modules/npm/bin/npm-cli.js"
        : "lib/node_modules/npm/bin/npm-cli.js",
    ),
  });
  const validate = Effect.fn("ManagedNodeRuntime.validate")(function* (root: string) {
    const runtime = paths(root);
    const version = yield* runner.run({
      command: runtime.node,
      args: ["--version"],
      timeout: "10 seconds",
    });
    if (
      version.code !== 0 ||
      version.stdout.trim() !== `v${NODE_VERSION}` ||
      !(yield* fs.exists(runtime.npm))
    )
      return yield* failure("The managed Node.js installation is incomplete.");
    return runtime;
  });
  return yield* Effect.gen(function* () {
    const sentinel = path.join(directory, ".verified");
    if (
      (yield* fs.readFileString(sentinel).pipe(Effect.orElseSucceed(() => ""))) === archive.sha256
    ) {
      const cached = yield* validate(directory).pipe(Effect.option);
      if (cached._tag === "Some") return cached.value;
    }
    const client = yield* HttpClient.HttpClient;
    yield* fs.makeDirectory(baseDirectory, { recursive: true });
    const stage = yield* fs.makeTempDirectoryScoped({ directory: baseDirectory, prefix: ".node-" });
    yield* Effect.logInfo("Downloading the managed Node.js runtime for extensions", {
      version: NODE_VERSION,
      platform: key,
    });
    const response = yield* client
      .get(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.${archive.suffix}`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout("1 minute"));
    let received = 0;
    const chunks = yield* response.stream.pipe(
      Stream.timeout("1 minute"),
      Stream.tap((chunk) =>
        Effect.suspend(() => {
          received += chunk.byteLength;
          return received > 256 * 1024 * 1024
            ? Effect.fail(failure("Node.js download exceeded its expected size."))
            : Effect.void;
        }),
      ),
      Stream.runCollect,
    );
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
    if (Hex.encode(new Uint8Array(digest)) !== archive.sha256)
      return yield* failure("The Node.js archive checksum did not match the pinned release.");
    const file = path.join(stage, `node.${archive.suffix}`);
    yield* fs.writeFile(file, bytes);
    const extracted = yield* runner.run({
      command: cliArchiveTarCommand(platform, environment),
      args: ["-xf", file, "-C", stage],
      timeout: "5 minutes",
      maxOutputBytes: 8192,
    });
    if (extracted.code !== 0)
      return yield* new ExtensionError({
        operation: "runtime",
        id: "node",
        reason: "install-failed",
        detail: "Could not extract the Node.js archive.",
        cause: new Error(extracted.stderr),
      });
    const unpacked = path.join(stage, name);
    yield* validate(unpacked);
    yield* fs.writeFileString(path.join(unpacked, ".verified"), archive.sha256);
    yield* fs.remove(directory, { recursive: true, force: true });
    yield* fs.rename(unpacked, directory);
    return paths(directory);
  }).pipe(
    Effect.scoped,
    installLock.withPermits(1),
    Effect.mapError(
      (cause) =>
        new ExtensionError({
          operation: "runtime",
          id: key,
          reason: "install-failed",
          detail: isExtensionError(cause) ? cause.detail : undefined,
          cause,
        }),
    ),
  );
});
