import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "vite-plus/test";

import { decrypt, encrypt, TOKEN } from "./plant-saved-connection.mjs";

const scriptPath = NodeURL.fileURLToPath(new URL("./plant-saved-connection.mjs", import.meta.url));

describe("plant-saved-connection", () => {
  it("plants under ~/.ominax and checks it there without creating ~/.t3-learn", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ominax-plant-default-"));
    const run = (command, password) =>
      NodeChildProcess.execFileSync(
        process.execPath,
        [scriptPath, command, "--platform", "linux", "--password", password],
        { env: { ...process.env, HOME: home }, stdio: "pipe" },
      );
    try {
      run("plant", "peanuts");
      assert.isTrue(
        NodeFS.existsSync(NodePath.join(home, ".ominax", "userdata", "connection-catalog.json")),
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, ".t3-learn")));
      run("check", "peanuts");
      expect(() => run("check", "other-key")).toThrow();
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("verifies a planted catalog after re-encryption", () => {
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
