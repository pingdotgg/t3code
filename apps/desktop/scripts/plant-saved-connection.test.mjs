import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { assert, describe, it } from "vite-plus/test";

import { decrypt, encrypt, TOKEN } from "./plant-saved-connection.mjs";

const scriptPath = NodeURL.fileURLToPath(new URL("./plant-saved-connection.mjs", import.meta.url));

describe("plant-saved-connection", () => {
  it("plants an old catalog and verifies it after re-encryption", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ominax-plant-"));
    const oldPassword = "old-safe-storage-password";
    const newPassword = "new-safe-storage-password";
    try {
      NodeChildProcess.execFileSync(process.execPath, [
        scriptPath,
        "plant",
        "--state-dir",
        stateDir,
        "--platform",
        "darwin",
        "--password",
        oldPassword,
      ]);
      const file = NodePath.join(stateDir, "connection-catalog.json");
      const document = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      const catalog = decrypt(
        Buffer.from(document.encryptedCatalog, "base64"),
        "darwin",
        oldPassword,
      );
      const decoded = JSON.parse(catalog);
      assert.equal(decoded.credentials[0].credential.token, TOKEN);
      NodeFS.copyFileSync(file, `${file}.pre-ominax`);
      document.encryptedCatalog = encrypt(catalog, "darwin", newPassword).toString("base64");
      NodeFS.writeFileSync(file, `${JSON.stringify(document)}\n`);
      NodeChildProcess.execFileSync(process.execPath, [
        scriptPath,
        "check",
        "--state-dir",
        stateDir,
        "--platform",
        "darwin",
        "--password",
        newPassword,
      ]);
      assert.throws(() =>
        NodeChildProcess.execFileSync(process.execPath, [
          scriptPath,
          "check",
          "--state-dir",
          stateDir,
          "--platform",
          "darwin",
          "--password",
          oldPassword,
        ]),
      );
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
