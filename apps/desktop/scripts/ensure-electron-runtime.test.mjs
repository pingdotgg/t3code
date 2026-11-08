import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it, vi } from "vite-plus/test";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { downloadElectronRuntime, verifyElectronZip } from "./ensure-electron-runtime.mjs";

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

describe("downloadElectronRuntime", () => {
  it("rejects a mismatched download before extracting and removes its temp files", () => {
    spawnSyncMock.mockReset();
    const electronDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-electron-test-"));
    let zipPath = "";
    spawnSyncMock.mockImplementation((command, args) => {
      if (command === "curl") {
        zipPath = args[args.indexOf("-o") + 1];
        NodeFS.writeFileSync(zipPath, "other bytes");
        NodeFS.writeFileSync(
          NodePath.join(electronDir, "checksums.json"),
          JSON.stringify({ [NodePath.basename(zipPath)]: sha256 }),
        );
      }
      return { status: 0 };
    });

    try {
      assert.throws(
        () => downloadElectronRuntime(electronDir, "1.2.3"),
        /Checksum mismatch for electron-v1\.2\.3-/,
      );
      assert.deepEqual(
        spawnSyncMock.mock.calls.map(([command]) => command),
        ["curl"],
      );
      assert.isFalse(NodeFS.existsSync(NodePath.dirname(zipPath)));
    } finally {
      NodeFS.rmSync(electronDir, { recursive: true, force: true });
    }
  });
});
