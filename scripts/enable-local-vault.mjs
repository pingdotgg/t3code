import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import {
  isVaultCiphertext,
  openVaultValue,
  readVaultKey,
  sealVaultValue,
  vaultKeyringAttributes,
  vaultMarker,
} from "../apps/server/src/auth/VaultCipher.ts";

function writePrivate(path, value) {
  const file = NodeFS.openSync(path, "wx", 0o600);
  try {
    NodeFS.writeFileSync(file, value);
    NodeFS.fsyncSync(file);
  } finally {
    NodeFS.closeSync(file);
  }
}

function syncDirectory(directory) {
  const fd = NodeFS.openSync(directory, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

async function enable(home) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone migration runs before the app's Effect runtime.
  if (NodeOS.platform() !== "linux" || !home) {
    throw new Error(
      "Usage on Linux, with Hyakki fully stopped: node scripts/enable-local-vault.mjs <Hyakki home>",
    );
  }
  const state = NodeFS.realpathSync(NodePath.join(home, "userdata"));
  const directory = NodeFS.realpathSync(NodePath.join(state, "secrets"));
  if (directory !== NodePath.join(state, "secrets"))
    throw new Error("The secrets directory must not be a symlink.");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(state, "server-owner.sqlite"));
  try {
    try {
      db.exec("BEGIN EXCLUSIVE");
    } catch {
      throw new Error(
        "Hyakki still owns this home. Stop the desktop, CLI and any background service first.",
      );
    }
    NodeFS.chmodSync(directory, 0o700);
    const marker = NodePath.join(directory, vaultMarker);
    if (NodeFS.existsSync(marker) && !NodeFS.lstatSync(marker).isFile()) {
      throw new Error("The vault marker must be a regular file.");
    }
    const existing = NodeFS.readdirSync(directory, { withFileTypes: true }).filter((file) =>
      file.name.endsWith(".bin"),
    );
    if (existing.some((file) => !file.isFile()))
      throw new Error("The vault contains an unexpected non-regular record.");
    const records = existing.map((file) => ({
      name: file.name.slice(0, -4),
      path: NodePath.join(directory, file.name),
    }));
    const hasCiphertext = records.some((file) => isVaultCiphertext(NodeFS.readFileSync(file.path)));
    let key;
    try {
      key = await readVaultKey(directory);
    } catch (error) {
      if (hasCiphertext || NodeFS.existsSync(marker)) throw error;
      const created = NodeCrypto.randomBytes(32);
      try {
        const result = NodeChildProcess.spawnSync(
          "/usr/bin/secret-tool",
          ["store", "--label=Hyakki local vault key", ...vaultKeyringAttributes(directory)],
          {
            input: created.toString("base64"),
            timeout: 10000,
            stdio: ["pipe", "ignore", "ignore"],
          },
        );
        if (result.status !== 0)
          throw new Error(
            "Could not store the vault key. Unlock the Linux keyring and try again.",
            { cause: error },
          );
        key = await readVaultKey(directory);
        if (!NodeCrypto.timingSafeEqual(key, created))
          throw new Error("The keyring returned a different vault key.", { cause: error });
      } finally {
        created.fill(0);
      }
    }
    try {
      for (const file of records) {
        const bytes = NodeFS.readFileSync(file.path);
        if (isVaultCiphertext(bytes)) openVaultValue(key, file.name, bytes).fill(0);
        bytes.fill(0);
      }
      if (!NodeFS.existsSync(marker)) writePrivate(marker, "1\n");
      syncDirectory(directory);
      let migrated = 0;
      for (const file of records) {
        const bytes = NodeFS.readFileSync(file.path);
        if (isVaultCiphertext(bytes)) continue;
        const temp = `${file.path}.${NodeCrypto.randomUUID()}.tmp`;
        try {
          const encrypted = sealVaultValue(key, file.name, bytes);
          const verified = openVaultValue(key, file.name, encrypted);
          try {
            if (!NodeCrypto.timingSafeEqual(bytes, verified))
              throw new Error("Vault verification failed.");
          } finally {
            verified.fill(0);
          }
          writePrivate(temp, encrypted);
          NodeFS.renameSync(temp, file.path);
          syncDirectory(directory);
          migrated += 1;
        } finally {
          bytes.fill(0);
          NodeFS.rmSync(temp, { force: true });
        }
      }
      console.log(`Hyakki vault enabled. Encrypted ${migrated} existing record(s).`);
    } finally {
      key.fill(0);
    }
  } finally {
    db.close();
  }
}

try {
  await enable(process.argv[2]);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not enable the Hyakki vault.");
  process.exitCode = 1;
}
