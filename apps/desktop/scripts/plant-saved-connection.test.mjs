import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "vite-plus/test";

import { decrypt, encrypt, TOKEN } from "./plant-saved-connection.mjs";

const scriptPath = NodeURL.fileURLToPath(new URL("./plant-saved-connection.mjs", import.meta.url));

describe("plant-saved-connection", () => {
  it("uses platform defaults and requires the migration backup", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ominax-plant-default-"));
    try {
      const env = { ...process.env, HOME: home };
      NodeChildProcess.execFileSync(
        process.execPath,
        [scriptPath, "plant", "--platform", "linux", "--password", "peanuts"],
        { env },
      );
      const oldFile = NodePath.join(home, ".t3-learn", "userdata", "connection-catalog.json");
      const currentDir = NodePath.join(home, ".ominax", "userdata");
      NodeFS.mkdirSync(currentDir, { recursive: true });
      NodeFS.copyFileSync(oldFile, NodePath.join(currentDir, "connection-catalog.json"));
      expect(() =>
        NodeChildProcess.execFileSync(
          process.execPath,
          [scriptPath, "check", "--platform", "linux", "--password", "peanuts"],
          { env },
        ),
      ).toThrow();
      NodeFS.rmSync(NodePath.join(home, ".t3-learn"), { recursive: true, force: true });
      NodeFS.symlinkSync(NodePath.join(home, ".ominax"), NodePath.join(home, ".t3-learn"));
      NodeFS.copyFileSync(
        NodePath.join(currentDir, "connection-catalog.json"),
        NodePath.join(currentDir, "connection-catalog.json.pre-ominax"),
      );
      NodeChildProcess.execFileSync(
        process.execPath,
        [scriptPath, "check", "--platform", "linux", "--password", "peanuts"],
        { env },
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails the shared-key Linux check until the home has moved", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ominax-plant-shared-"));
    const run = (command) =>
      NodeChildProcess.execFileSync(
        process.execPath,
        [scriptPath, command, "--platform", "linux"],
        {
          env: { ...process.env, HOME: home },
          stdio: "pipe",
        },
      );
    try {
      run("plant");
      expect(() => run("check")).toThrow();
      expect(NodeFS.existsSync(NodePath.join(home, ".ominax"))).toBe(false);
      NodeFS.renameSync(NodePath.join(home, ".t3-learn"), NodePath.join(home, ".ominax"));
      NodeFS.symlinkSync(NodePath.join(home, ".ominax"), NodePath.join(home, ".t3-learn"));
      run("check");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

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
