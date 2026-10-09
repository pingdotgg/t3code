import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as NodeZlib from "node:zlib";

import * as CuaDriverInstallation from "./CuaDriverInstallation.ts";

/** A stored ZIP with the Windows release's flat layout. */
const makeZip = (entries: ReadonlyArray<{ readonly name: string; readonly data: string }>) => {
  const records: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
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
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
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

const FILES = ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"];
const archive = makeZip(FILES.map((name) => ({ name, data: name })));

const makeHarness = Effect.fn("test.makeCuaDriverInstallation")(function* (
  options: { readonly sha256?: string; readonly archive?: Buffer } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cua-install-test-" });
  const body = options.archive ?? archive;
  const requests: Array<string> = [];
  const installation = yield* CuaDriverInstallation.makeCuaDriverInstallation({
    baseDir,
    release: {
      version: "9.9.9",
      archiveName: "cua-driver-fixture.zip",
      format: "zip",
      url: "https://github.com/trycua/cua/releases/download/fixture.zip",
      bytes: body.byteLength,
      sha256: options.sha256 ?? Hex.encode(yield* crypto.digest("SHA-256", body)),
      executable: "cua-driver.exe",
      requiredFiles: FILES,
    },
  }).pipe(
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          const response = HttpClientResponse.fromWeb(request, new Response(null));
          return Object.defineProperty(response, "stream", { value: Stream.make(body) });
        }),
      ),
    ),
  );
  return {
    installation,
    fs,
    path,
    installRoot: path.join(baseDir, "tools", "cua-driver"),
    requests,
  };
});

it.layer(NodeServices.layer)("CuaDriverInstallation", (it) => {
  it.effect("installs the verified release once and replaces older versions", () =>
    Effect.gen(function* () {
      const { installation, fs, path, installRoot, requests } = yield* makeHarness();
      yield* fs.makeDirectory(path.join(installRoot, "0.1.0"), { recursive: true });

      const executable = yield* installation.executable;

      expect(executable).toBe(path.join(installRoot, "9.9.9", "cua-driver.exe"));
      expect(yield* fs.readFileString(path.join(installRoot, "9.9.9", "cua-driver-uia.exe"))).toBe(
        "cua-driver-uia.exe",
      );
      expect(yield* fs.readDirectory(installRoot)).toEqual(["9.9.9"]);
      expect(yield* installation.executable).toBe(executable);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("installs nothing from a download that fails its checksum", () =>
    Effect.gen(function* () {
      const { installation, fs, installRoot } = yield* makeHarness({ sha256: "0".repeat(64) });

      const error = yield* Effect.flip(installation.executable);

      expect(error.message).toContain("SHA-256");
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an archive entry that escapes the install directory", () =>
    Effect.gen(function* () {
      const unsafe = makeZip([
        ...FILES.map((name) => ({ name, data: name })),
        { name: "../escape.exe", data: "x" },
      ]);
      const { installation, fs, path, installRoot } = yield* makeHarness({ archive: unsafe });

      // yauzl's strict file names or the install's own check refuses it.
      yield* Effect.flip(installation.executable);

      expect(yield* fs.exists(path.join(path.dirname(installRoot), "escape.exe"))).toBe(false);
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
