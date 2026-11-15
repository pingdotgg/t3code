import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeZlib from "node:zlib";

import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import { chromeBrands, fullChromeRelease, HEADLESS_SHELL_PROFILE } from "./previewChrome.ts";

const storedZip = (entries: ReadonlyArray<{ readonly name: string; readonly mode: number }>) => {
  const records: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.name.endsWith("/") ? "" : "#!/bin/sh\n");
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

it("pins full Chrome where its archive unpacks, and keeps the shell on macOS", () => {
  expect(fullChromeRelease("linux64")).toMatchObject({
    product: "chrome",
    executable: "chrome",
    url: expect.stringMatching(/\/linux64\/chrome-linux64\.zip$/),
  });
  expect(fullChromeRelease("win64")?.executable).toBe("chrome.exe");
  expect(fullChromeRelease("mac-arm64")).toBeNull();
});

it.effect.each([
  { label: "no profile", restricted: "1\n", profile: undefined, blocked: true },
  {
    label: "the profile an older T3 wrote",
    restricted: "1\n",
    profile: HEADLESS_SHELL_PROFILE,
    blocked: true,
  },
  {
    label: "the current profile",
    restricted: "1\n",
    profile: PreviewBrowserHost.APPARMOR_PROFILE,
    blocked: false,
  },
  {
    label: "an administrator's profile",
    restricted: "1\n",
    profile: "profile edited {}\n",
    blocked: false,
  },
  {
    label: "no userns restriction",
    restricted: "0\n",
    profile: HEADLESS_SHELL_PROFILE,
    blocked: false,
  },
])("full Chrome's sandbox counts as blocked with $label", (input) =>
  Effect.gen(function* () {
    const files = new Map([
      ["/proc/sys/kernel/apparmor_restrict_unprivileged_userns", input.restricted],
    ]);
    if (input.profile !== undefined)
      files.set(PreviewBrowserHost.APPARMOR_PROFILE_PATH, input.profile);
    const fileSystem = FileSystem.makeNoop({
      exists: (path) => Effect.succeed(files.has(path)),
      readFileString: (path) => {
        const content = files.get(path);
        return content === undefined ? Effect.die(`no ${path}`) : Effect.succeed(content);
      },
    });
    const blocked = yield* PreviewBrowserHost.sandboxBlocked.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
    expect(blocked).toBe(input.blocked);
  }),
);

it("builds the brand list real Chrome sends", () => {
  // Read from google-chrome 150.0.7871.114 with navigator.userAgentData.getHighEntropyValues.
  expect(chromeBrands(150, (version) => version)).toEqual([
    { brand: "Not;A=Brand", version: "8" },
    { brand: "Chromium", version: "150" },
    { brand: "Google Chrome", version: "150" },
  ]);
  expect(chromeBrands(156, (version) => version)[0]).toEqual({
    brand: "Not:A-Brand",
    version: "8",
  });
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("full Chrome install", (it) => {
  it.effect("installs the chrome executable under tools/chrome and keeps the shell", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const digest = yield* Digest.Digest;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-full-chrome-test-" });
      const shell = path.join(baseDir, "tools", "chrome-headless-shell", "fixture");
      yield* fs.makeDirectory(path.join(shell, "1.0.0"), { recursive: true });
      const archive = storedZip([
        { name: "chrome-fixture/", mode: 0o40755 },
        { name: "chrome-fixture/chrome", mode: 0o100755 },
      ]);
      const browser = yield* PreviewBrowser.makePreviewBrowser({
        baseDir,
        release: {
          version: "1.2.3",
          platform: "fixture",
          product: "chrome",
          executable: "chrome",
          url: "https://storage.googleapis.com/chrome-fixture.zip",
          bytes: archive.byteLength,
          sha256: Hex.encode(yield* digest.digest(Digest.sha256, archive).pipe(Effect.orDie)),
        },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() =>
              Object.defineProperty(
                HttpClientResponse.fromWeb(request, new Response(null)),
                "stream",
                { value: Stream.make(archive) },
              ),
            ),
          ),
        ),
      );

      expect(yield* browser.executable).toBe(
        path.join(baseDir, "tools", "chrome", "fixture", "1.2.3", "chrome"),
      );
      expect(yield* fs.exists(shell)).toBe(true);
    }).pipe(Effect.scoped),
  );
});
