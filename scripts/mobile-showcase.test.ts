// @effect-diagnostics nodeBuiltinImport:off - Clears capture outputs in a real temporary folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { PNG } from "pngjs";

import showcaseConfig, {
  type ShowcaseScene,
  type ShowcaseStoreAssetSpec,
} from "./mobile-showcase.config.ts";
import {
  clearShowcaseCaptureOutputs,
  encodeAndroidPairingUrls,
  normalizeStorePng,
  parsePairingCredentialOutput,
  planShowcaseCaptures,
  readPngMetadata,
  showcaseCaptureDirectory,
  validateStoreAsset,
} from "./mobile-showcase.ts";

function rgbaPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

it("converts simulator RGBA captures to upload-safe 24-bit RGB PNGs", () => {
  const normalized = normalizeStorePng(rgbaPng(2, 3));
  assert.deepStrictEqual(readPngMetadata(normalized), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

const storeSpec: ShowcaseStoreAssetSpec = {
  store: "apple",
  directory: "fixture",
  width: 2,
  height: 3,
  minimumUploadCount: 1,
  maximumUploadCount: 10,
};

it("validates a complete RGB PNG from an offset byte view", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const padded = Buffer.concat([Buffer.from([0]), bytes, Buffer.from([0])]);
  assert.deepStrictEqual(validateStoreAsset(storeSpec, padded.subarray(1, -1)), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

it("rejects PNG metadata without image data during store validation", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  assert.throws(
    () => validateStoreAsset(storeSpec, bytes.subarray(0, 26), "threads.png"),
    /threads\.png is not a valid PNG/,
  );
  assert.throws(() => validateStoreAsset(storeSpec, bytes.subarray(0, 33)), /is not a valid PNG/);
});

it("rejects a PNG truncated inside its image data", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const imageData = bytes.indexOf("IDAT");
  assert.notEqual(imageData, -1);
  assert.throws(
    () => validateStoreAsset(storeSpec, bytes.subarray(0, imageData + 5)),
    /is not a valid PNG/,
  );
});

it("rejects a PNG with a corrupt image-data checksum", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const imageData = bytes.indexOf("IDAT");
  assert.notEqual(imageData, -1);
  const checksum = imageData + 4 + bytes.readUInt32BE(imageData - 4);
  bytes[checksum] = bytes.readUInt8(checksum) ^ 1;
  assert.throws(() => validateStoreAsset(storeSpec, bytes), /is not a valid PNG/);
});

it("reads multiline JSON from the pairing CLI", () => {
  assert.equal(
    parsePairingCredentialOutput('server log\n{\n  "credential": "PAIR-ME"\n}\n'),
    "PAIR-ME",
  );
});

it("encodes Android pairing URLs without shell-sensitive JSON quotes", () => {
  const urls = ["http://10.0.2.2:65164/#token=ONE", "http://10.0.2.2:65198/#token=TWO"];
  const encoded = encodeAndroidPairingUrls(urls);
  assert.equal(encoded.startsWith("json-uri:"), true);
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(encoded.slice("json-uri:".length))), urls);
  assert.equal(encoded.includes('"'), false);
});

it("keeps unselected scenes on a partial capture and clears the folder on a full one", async () => {
  const pixel = showcaseConfig.devices.find((device) => device.id === "pixel");
  assert.ok(pixel);
  const seeded = [...pixel.scenes.map((scene) => `${scene}.png`), "stale.png"];
  const cases = [
    {
      scenes: new Set<ShowcaseScene>(["thread"]),
      remaining: seeded.filter((file) => file !== "thread.png"),
    },
    { scenes: new Set<ShowcaseScene>(), remaining: [] },
  ];
  const outputDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-showcase-test-"),
  );
  try {
    for (const { scenes, remaining } of cases) {
      const [capture] = planShowcaseCaptures(showcaseConfig, {
        platforms: new Set(),
        deviceIds: new Set(["pixel"]),
        scenes,
        appearances: new Set(),
        themes: new Set(),
      });
      assert.ok(capture);
      const directory = showcaseCaptureDirectory(outputDirectory, capture);
      await NodeFSP.mkdir(directory, { recursive: true });
      for (const file of seeded) {
        await NodeFSP.writeFile(NodePath.join(directory, file), "png");
      }
      await clearShowcaseCaptureOutputs(outputDirectory, capture);
      assert.deepStrictEqual((await NodeFSP.readdir(directory)).sort(), remaining.sort());
    }
  } finally {
    await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
  }
});
