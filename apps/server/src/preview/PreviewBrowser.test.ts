import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import type * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeZlib from "node:zlib";

import * as PreviewBrowser from "./PreviewBrowser.ts";

// NTFS cannot enforce POSIX modes; choose the host platform.
const hostPlatform: NodeJS.Platform =
  HostProcess.Platform.defaultValue() === "win32" ? "win32" : "linux";
const executableName =
  hostPlatform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
const ROOT = "chrome-headless-shell-fixture/";

const makeZip = (
  entries: ReadonlyArray<{ readonly name: string; readonly data?: string; readonly mode: number }>,
) => {
  const records: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
};

const browserArchive = makeZip([
  { name: ROOT, mode: 0o40755 },
  { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
  { name: `${ROOT}libEGL.so`, data: "library", mode: 0o100755 },
  { name: `${ROOT}locales/`, mode: 0o40755 },
  { name: `${ROOT}locales/en-US.pak`, data: "strings", mode: 0o100644 },
]);

const makeHarness = Effect.fn("test.makePreviewBrowser")(function* (
  options: {
    readonly version?: string;
    readonly archive?: Buffer;
    readonly sha256?: string;
    readonly body?: Stream.Stream<Uint8Array>;
    readonly wait?: Duration.Input;
    readonly unsupported?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preview-browser-test-" });
  const archive = options.archive ?? browserArchive;
  const digest = yield* Digest.Digest;
  const sha256 =
    options.sha256 ?? Hex.encode(yield* digest.digest(Digest.sha256, archive).pipe(Effect.orDie));
  const requests: Array<string> = [];
  const browser = yield* PreviewBrowser.makePreviewBrowser({
    baseDir,
    ...(options.unsupported
      ? {}
      : {
          release: {
            version: options.version ?? "1.2.3",
            platform: "fixture",
            url: "https://storage.googleapis.com/chrome-headless-shell-fixture.zip",
            bytes: archive.byteLength,
            sha256,
          },
        }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  }).pipe(
    Effect.provideService(HostProcess.Platform, options.unsupported ? "freebsd" : hostPlatform),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provideService(HostProcess.Environment, options.environment ?? {}),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          const response = HttpClientResponse.fromWeb(request, new Response(null));
          return Object.defineProperty(response, "stream", {
            value: options.body ?? Stream.make(archive.subarray(0, 40), archive.subarray(40)),
          });
        }),
      ),
    ),
  );
  const installRoot = path.join(baseDir, "tools", "chrome-headless-shell", "fixture");
  return { browser, fs, path, baseDir, installRoot, requests };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PreviewBrowser", (it) => {
  it.effect.each([false, true])(
    "uses the configured executable without installing (unsupported platform: %s)",
    (unsupported) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const executable = path.join(directory, "custom chromium");
        const target = path.join(directory, "chromium");
        yield* fs.writeFileString(target, "#!/bin/sh\n", { mode: 0o755 });
        yield* hostPlatform === "win32"
          ? fs.copyFile(target, executable)
          : fs.symlink(target, executable);
        const { browser, baseDir, requests } = yield* makeHarness({
          unsupported,
          environment: { T3CODE_BROWSER_EXECUTABLE_PATH: executable },
        });

        expect(yield* browser.installed).toEqual(Option.some(executable));
        expect(yield* browser.executable).toBe(executable);
        expect(requests).toEqual([]);
        expect(yield* fs.exists(path.join(baseDir, "tools"))).toBe(false);
      }),
  );

  it.effect.each([
    { name: "an empty path", value: "", absolute: false },
    { name: "a whitespace path", value: " ", absolute: false },
    { name: "a relative path", value: "./chromium", absolute: false },
    { name: "a missing file", value: "missing", absolute: true },
    { name: "a directory", value: "directory", absolute: true },
    ...(hostPlatform === "win32"
      ? []
      : [{ name: "a non-executable file", value: "not-executable", absolute: true }]),
    ...(hostPlatform === "win32" || HostProcess.UserId.defaultValue() === 0
      ? []
      : [{ name: "execution denied to its owner", value: "owner-denied", absolute: true }]),
  ])("rejects $name without falling back to a download", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(directory, "directory"));
      yield* fs.writeFileString(path.join(directory, "not-executable"), "", { mode: 0o644 });
      yield* fs.writeFileString(path.join(directory, "owner-denied"), "", { mode: 0o655 });
      const { browser, baseDir, requests } = yield* makeHarness({
        environment: {
          T3CODE_BROWSER_EXECUTABLE_PATH: testCase.absolute
            ? path.join(directory, testCase.value)
            : testCase.value,
        },
      });

      expect(yield* browser.installed).toEqual(Option.none());
      const error = yield* browser.executable.pipe(Effect.flip);
      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(error.message).toContain("T3CODE_BROWSER_EXECUTABLE_PATH");
      expect(yield* browser.installed).toEqual(Option.none());
      expect(requests).toEqual([]);
      expect(yield* fs.exists(path.join(baseDir, "tools"))).toBe(false);
    }),
  );

  it.effect("keeps the unsupported-platform error when the override is unset", () =>
    Effect.gen(function* () {
      const { browser, fs, path, baseDir, requests } = yield* makeHarness({ unsupported: true });

      expect(yield* browser.installed).toEqual(Option.none());
      expect(yield* browser.executable.pipe(Effect.flip)).toMatchObject({
        _tag: "PreviewBrowserUnsupportedError",
        platform: "freebsd",
        arch: "x64",
      });
      expect(requests).toEqual([]);
      expect(yield* fs.exists(path.join(baseDir, "tools"))).toBe(false);
    }),
  );

  it.effect("reuses a managed executable when the override is unset", () =>
    Effect.gen(function* () {
      const { browser, fs, path, installRoot, requests } = yield* makeHarness();
      const directory = path.join(installRoot, "1.2.3");
      const executable = path.join(directory, executableName);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(executable, "#!/bin/sh\n", { mode: 0o755 });

      expect(yield* browser.installed).toEqual(Option.some(executable));
      expect(yield* browser.executable).toBe(executable);
      expect(requests).toEqual([]);
    }),
  );

  it.effect.each(["0.8.0", "1.2.3"])("retains another version when installing %s", (current) =>
    Effect.gen(function* () {
      const { browser, fs, path, installRoot, requests } = yield* makeHarness({ version: current });
      yield* fs.makeDirectory(path.join(installRoot, "0.9.0"), { recursive: true });
      yield* fs.makeDirectory(path.join(installRoot, "0.10.0"));
      const active = path.join(installRoot, ".install-other");
      const abandoned = path.join(installRoot, ".install-abandoned");
      yield* fs.makeDirectory(active);
      yield* fs.makeDirectory(abandoned);
      const twoHoursAgo = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { hours: 2 }));
      yield* fs.utimes(abandoned, twoHoursAgo, twoHoursAgo);
      expect(yield* browser.installed).toEqual(Option.none());

      const executable = yield* browser.executable;

      const version = path.join(installRoot, current);
      expect(executable).toBe(path.join(version, executableName));
      expect(yield* fs.readFileString(path.join(version, "locales", "en-US.pak"))).toBe("strings");
      if (hostPlatform !== "win32") {
        const mode = (file: string) =>
          fs.stat(path.join(version, file)).pipe(Effect.map((info) => info.mode & 0o777));
        expect(yield* mode(executableName)).toBe(0o755);
        expect(yield* mode("libEGL.so")).toBe(0o755);
        expect(yield* mode(path.join("locales", "en-US.pak"))).toBe(0o644);
      }
      expect((yield* fs.readDirectory(installRoot)).toSorted()).toEqual(
        [".install-other", "0.10.0", current].toSorted(),
      );
      expect(yield* browser.executable).toBe(executable);
      expect(yield* browser.installed).toEqual(Option.some(executable));
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "a hash mismatch", sha256: "0".repeat(64) },
    { name: "a short download", body: Stream.make(browserArchive.subarray(0, -1)) },
    {
      name: "an oversized download",
      body: Stream.make(browserArchive, Buffer.from("extra")),
    },
  ])("rejects $name, installs nothing, and retries on the next call", (testCase) =>
    Effect.gen(function* () {
      const { browser, fs, installRoot, requests } = yield* makeHarness(testCase);

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(error.message).toMatch(/^T3 could not install its headless browser: .+ Try again\.$/);
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
      yield* browser.executable.pipe(Effect.flip);
      expect(requests).toHaveLength(2);
    }),
  );

  it.effect.each([
    { name: "a parent-directory entry", entry: `${ROOT}../escape` },
    { name: "an absolute entry", entry: "/escape" },
    { name: "an entry outside the top directory", entry: "escape" },
  ])("rejects an archive with $name", (testCase) =>
    Effect.gen(function* () {
      const { browser, fs, path, baseDir, installRoot } = yield* makeHarness({
        archive: makeZip([
          { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
          { name: testCase.entry, data: "escaped", mode: 0o100644 },
        ]),
      });

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
      expect(yield* fs.exists(path.join(baseDir, "tools", "chrome-headless-shell", "escape"))).toBe(
        false,
      );
    }),
  );
});
