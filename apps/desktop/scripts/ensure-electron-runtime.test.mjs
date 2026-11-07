import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "vite-plus/test";

import { verifyElectronZip } from "./ensure-electron-runtime.mjs";

const fileName = "electron-v1.2.3-linux-x64.zip";
const bytes = Buffer.from("electron zip bytes");
const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");

describe("verifyElectronZip", () => {
  it.each([
    { name: "accepts a matching checksum", checksums: { [fileName]: sha256 }, error: undefined },
    {
      name: "rejects a mismatched checksum",
      checksums: { [fileName]: "0".repeat(64) },
      error: /Checksum mismatch for electron-v1\.2\.3-linux-x64\.zip/,
    },
    {
      name: "rejects a zip with no checksum entry",
      checksums: { "electron-v1.2.3-darwin-arm64.zip": sha256 },
      error: /No checksum for electron-v1\.2\.3-linux-x64\.zip/,
    },
  ])("$name", ({ checksums, error }) => {
    if (error) {
      assert.throws(() => verifyElectronZip(fileName, bytes, checksums), error);
    } else {
      assert.doesNotThrow(() => verifyElectronZip(fileName, bytes, checksums));
    }
  });
});
