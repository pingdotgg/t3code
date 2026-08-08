// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  isTranscodableImageMimeType,
  TRANSCODED_IMAGE_MIME_TYPE,
  transcodeImageToJpeg,
} from "./imageTranscode.ts";

// 8x8 RGB PNG, used as the source for the HEIC fixture below.
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAbElEQVR4nA3JQQEAMAgDMZRUCUqqpEpQgoh7o2jLN1WFii5cpJhiiyuqhEQLi4gRK04/GjXduEkzzTbXP4xMG5uYMWvOP4JCB4eECRsuPwYNPXjIMMMONz8WLb14yTLLLrc/Dh19+Mgxxx53PKaVZoFj4h8/AAAAAElFTkSuQmCC";

const JPEG_START_OF_IMAGE = [0xff, 0xd8, 0xff];

function runSips(args: Array<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile("sips", args, (error) =>
      error === null ? resolve() : reject(error),
    );
  });
}

// `sips` is the macOS transcoder, and also the only way to build a real HEIC
// fixture without shipping a binary in the repo. Probing for it keeps this
// suite green on hosts that do not have it.
const SIPS_AVAILABLE = await runSips(["--version"]).then(
  () => true,
  () => false,
);

async function makeHeicFixture(): Promise<Uint8Array> {
  const workingDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-heic-fixture-"));
  const pngPath = NodePath.join(workingDir, "source.png");
  const heicPath = NodePath.join(workingDir, "source.heic");

  try {
    await NodeFSP.writeFile(pngPath, Buffer.from(SAMPLE_PNG_BASE64, "base64"));
    await runSips(["-s", "format", "heic", pngPath, "--out", heicPath]);
    return new Uint8Array(await NodeFSP.readFile(heicPath));
  } finally {
    await NodeFSP.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("imageTranscode", () => {
  it("recognizes the mime types Claude cannot ingest", () => {
    expect(isTranscodableImageMimeType("image/heic")).toBe(true);
    expect(isTranscodableImageMimeType("image/heif")).toBe(true);
    expect(isTranscodableImageMimeType("IMAGE/HEIC")).toBe(true);
    expect(isTranscodableImageMimeType(" image/heic ")).toBe(true);
  });

  it("leaves natively supported mime types alone", () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(isTranscodableImageMimeType(mimeType)).toBe(false);
    }
  });

  it("targets jpeg, which every provider accepts", () => {
    expect(TRANSCODED_IMAGE_MIME_TYPE).toBe("image/jpeg");
  });

  it.skipIf(!SIPS_AVAILABLE)("converts HEIC bytes into JPEG bytes", async () => {
    const heic = await makeHeicFixture();
    // Guards against the fixture silently degrading into a non-HEIC file.
    expect(Buffer.from(heic.subarray(4, 12)).toString("ascii")).toBe("ftypheic");

    const jpeg = await transcodeImageToJpeg({
      bytes: heic,
      platform: "darwin",
    });

    expect(jpeg.byteLength).toBeGreaterThan(0);
    expect([...jpeg.subarray(0, 3)]).toEqual(JPEG_START_OF_IMAGE);
  });

  it.skipIf(!SIPS_AVAILABLE)("rejects bytes that are not a decodable image", async () => {
    await expect(
      transcodeImageToJpeg({
        bytes: new TextEncoder().encode("not an image"),
        platform: "darwin",
      }),
    ).rejects.toThrow();
  });
});
