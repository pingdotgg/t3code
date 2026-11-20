// @effect-diagnostics nodeBuiltinImport:off -- Intercepts the spawn electron-updater requires natively, and serves updates over node:http.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { autoUpdater } from "electron-updater";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import type * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeZlib from "node:zlib";
import { vi } from "vite-plus/test";

// electron-updater requires Electron natively, outside vi.mock's reach, and builds its
// autoUpdater singleton as soon as it is imported.
vi.hoisted(() => {
  const NodeModule = process.getBuiltinModule("node:module");
  const NodeEvents = process.getBuiltinModule("node:events");
  const require = NodeModule.createRequire(import.meta.url);
  const electronPath = NodeModule.createRequire(require.resolve("electron-updater")).resolve(
    "electron",
  );
  const electronModule = new NodeModule.Module(electronPath);
  electronModule.filename = electronPath;
  electronModule.loaded = true;
  electronModule.exports = {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "T3 Code",
      isPackaged: true,
      quit: () => undefined,
      once: () => undefined,
    },
    autoUpdater: new NodeEvents.EventEmitter(),
  };
  require.cache[electronPath] = electronModule;
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

const childProcess = NodeModule.createRequire(import.meta.url)("node:child_process") as {
  spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater AppImage install",
  () => {
    it.live("relaunches the installed AppImage without the updating process's descriptors", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-appimage-install-" });
        const appImagePath = path.join(dir, "T3-Code.AppImage");
        const stagedPath = path.join(dir, "T3-Code-1.0.1.AppImage");
        const fdReportPath = path.join(dir, "relaunched-fds.txt");
        yield* fileSystem.writeFileString(appImagePath, "old AppImage");
        yield* fileSystem.writeFileString(
          stagedPath,
          `#!/bin/sh\nls /proc/self/fd > '${fdReportPath}'\n`,
        );
        yield* fileSystem.chmod(stagedPath, 0o755);

        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("APPIMAGE", appImagePath)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        autoUpdater.logger = null;
        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: stagedPath,
            downloadedFileInfo: { isAdminRightsRequired: false },
          },
        });

        // Electron's main process holds the AppImage runtime's keepalive pipe and some
        // Chromium files without O_CLOEXEC. Node cannot hold such a descriptor, so the
        // relaunch runs with fd 7 opened that way to stand in for them.
        const relaunched = yield* Deferred.make<void>();
        const realSpawn = childProcess.spawn;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            childProcess.spawn = (command, args, options) => {
              const child = realSpawn(
                "bash",
                ["-c", 'exec 7</dev/null; exec "$@"', "leaky-parent", command, ...args],
                options,
              );
              child.once("exit", () => Deferred.doneUnsafe(relaunched, Effect.void));
              return child;
            };
            NodeModule.syncBuiltinESMExports();
          }),
          () =>
            Effect.sync(() => {
              childProcess.spawn = realSpawn;
              NodeModule.syncBuiltinESMExports();
            }),
        );

        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        yield* Deferred.await(relaunched);

        const descriptors = (yield* fileSystem.readFileString(fdReportPath)).trim().split("\n");
        assert.notInclude(
          descriptors,
          "7",
          `relaunched AppImage inherited the updating process's fd 7 (open fds: ${descriptors.join(" ")})`,
        );
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);

// Electron's net module only exists in Electron; node:http stands in under the real download code.
// `onRead` sees each response after electron-updater has handled its end.
class NodeHttpExecutor extends ElectronHttpExecutor {
  readonly onRead: (response: NodeHttp.IncomingMessage) => void;
  constructor(onRead: (response: NodeHttp.IncomingMessage) => void) {
    super();
    this.onRead = onRead;
  }
  override createRequest(options: NodeHttp.RequestOptions, callback: (response: unknown) => void) {
    return NodeHttp.request(options, (response) => {
      callback(response);
      response.once("end", () => this.onRead(response));
    }) as unknown as ReturnType<ElectronHttpExecutor["createRequest"]>;
  }
}

// An AppImage: 16-byte blocks, then its deflated block map and the map's length.
const appImage = (blocks: ReadonlyArray<string>) => {
  const blockMap = NodeZlib.deflateRawSync(
    JSON.stringify({
      version: "2",
      files: [{ name: "file", offset: 0, checksums: blocks, sizes: blocks.map(() => 16) }],
    }),
  );
  const blockMapSize = Buffer.alloc(4);
  blockMapSize.writeUInt32BE(blockMap.length);
  const content = Buffer.from(blocks.map((block) => block.repeat(16).slice(0, 16)).join(""));
  return { file: Buffer.concat([content, blockMap, blockMapSize]), blockMapSize: blockMap.length };
};

type AppImage = ReturnType<typeof appImage>;

// Serves the update, reports where each request into its blocks starts, and stalls the requests
// `stall` picks after a few bytes.
const stallingUpdateServer = Effect.fn(function* (
  update: AppImage,
  stall: (start: number, seen: number) => boolean,
) {
  const { file } = update;
  const blocksEnd = file.length - update.blockMapSize - 4;
  const stalls = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const requests = yield* Queue.unbounded<number>();
  const seen = new Map<number, number>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range ?? "");
        const [start, end] = range ? [Number(range[1]), Number(range[2])] : [0, file.length - 1];
        const body = file.subarray(start, end + 1);
        const count = (seen.get(start) ?? 0) + 1;
        seen.set(start, count);
        if (start < blocksEnd) Queue.offerUnsafe(requests, start);
        response.writeHead(range ? 206 : 200, {
          "content-length": body.length,
          ...(range ? { "content-range": `bytes ${start}-${end}/${file.length}` } : {}),
        });
        if (!stall(start, count)) {
          response.end(body);
          return;
        }
        const closed = Deferred.makeUnsafe<void>();
        response.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
        response.write(body.subarray(0, 4));
        Queue.offerUnsafe(stalls, closed);
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: new URL(`http://127.0.0.1:${port}/T3-Code-1.0.1.AppImage`), stalls, requests };
});

// Points the real autoUpdater at an installed ["A", "B"] AppImage and a local server for `update`.
// `read` gets the start of each range of blocks electron-updater has finished reading.
const serveUpdate = Effect.fn(function* (
  update: AppImage,
  options: {
    readonly differential: boolean;
    readonly stall: (start: number, seen: number) => boolean;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-update-stall-" });
  const installedPath = path.join(dir, "T3-Code.AppImage");
  yield* fileSystem.writeFile(installedPath, appImage(["A", "B"]).file);
  yield* Effect.acquireRelease(
    Effect.sync(() => vi.stubEnv("APPIMAGE", installedPath)),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );
  const server = yield* stallingUpdateServer(update, options.stall);
  const { url } = server;
  const blocksEnd = update.file.length - update.blockMapSize - 4;
  const read = yield* Queue.unbounded<number>();
  const fileInfo = {
    url: url.pathname.slice(1),
    size: update.file.length,
    blockMapSize: update.blockMapSize,
    sha512: NodeCrypto.createHash("sha512").update(update.file).digest("base64"),
  };
  autoUpdater.logger = null;
  autoUpdater.disableDifferentialDownload = !options.differential;
  Object.assign(autoUpdater, {
    httpExecutor: new NodeHttpExecutor((response) => {
      const start = Number(/bytes (\d+)-/.exec(response.headers["content-range"] ?? "")?.[1]);
      if (start < blocksEnd) Queue.offerUnsafe(read, start);
    }),
    downloadedUpdateHelper: new DownloadedUpdateHelper(path.join(dir, "cache")),
    updateInfoAndProvider: {
      info: { version: "1.0.1", files: [fileInfo], path: fileInfo.url, ...fileInfo },
      provider: {
        resolveFiles: () => [{ url, info: fileInfo }],
        fileExtraDownloadHeaders: null,
        isUseMultipleRangeRequest: false,
      },
    },
  });
  return { ...server, read };
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater stalled download",
  () => {
    const cancelAndRetry = (differential: boolean) =>
      Effect.gen(function* () {
        const { stalls } = yield* serveUpdate(appImage(["A", "C"]), {
          differential,
          stall: (start) => start < 32,
        });
        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.on("error", () => undefined);
        const download = yield* Effect.forkChild(electronUpdater.downloadUpdate);
        const stalled = yield* Queue.take(stalls);
        yield* Fiber.interrupt(download);
        // The bounds only fail a cancelled transfer that stays open or keeps holding the updater.
        const closed = yield* Deferred.await(stalled).pipe(Effect.timeoutOption("2 seconds"));
        assert.isTrue(Option.isSome(closed), "the cancelled request stayed open");

        const retry = yield* Effect.forkChild(electronUpdater.downloadUpdate);
        const retried = yield* Queue.take(stalls).pipe(Effect.timeoutOption("2 seconds"));
        assert.isTrue(Option.isSome(retried), "the retry joined the cancelled download");
        yield* Fiber.interrupt(retry);
      }).pipe(Effect.scoped, Effect.provide([ElectronUpdater.layer, NodeServices.layer]));

    it.live("a cancelled full download closes its request and a retry downloads again", () =>
      cancelAndRetry(false),
    );

    it.live(
      "a cancelled differential download closes its request and a retry downloads again",
      () => cancelAndRetry(true),
    );

    it.live("a differential download cancelled between ranges opens no further range", () =>
      Effect.gen(function* () {
        // 101 changed blocks between copies of "A": electron-updater pauses for a second after
        // the 100th range before it copies "A" and opens the last one.
        const update = appImage(
          Array.from({ length: 101 }, (_, index) => ["A", `n${index}`]).flat(),
        );
        const firstRange = 16;
        const { stalls, requests, read } = yield* serveUpdate(update, {
          differential: true,
          // The retry stalls on its first range, so any later range is the cancelled download's.
          stall: (start, seen) => start === firstRange && seen > 1,
        });
        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.on("error", () => undefined);
        const download = yield* Effect.forkChild(electronUpdater.downloadUpdate);
        // Reading the 100th range starts the pause.
        yield* Queue.takeN(read, 100);
        yield* Fiber.interrupt(download);
        yield* Queue.clear(requests);

        const retry = yield* Effect.forkChild(electronUpdater.downloadUpdate);
        yield* Queue.take(stalls);
        assert.strictEqual(yield* Queue.take(requests), firstRange, "the retry did not start over");
        // The cancelled download's pause ends a second after it began.
        const late = yield* Queue.take(requests).pipe(Effect.timeoutOption("2 seconds"));
        assert.deepStrictEqual(late, Option.none(), "the cancelled download opened another range");
        yield* Fiber.interrupt(retry);
      }).pipe(Effect.scoped, Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);
