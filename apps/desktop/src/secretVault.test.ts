import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SecretVault, type SafeStorageLike } from "./secretVault";

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => {
    const decoded = value.toString("utf8");
    if (!decoded.startsWith("encrypted:")) {
      throw new Error("Unexpected ciphertext");
    }
    return decoded.slice("encrypted:".length);
  },
};

describe("SecretVault", () => {
  it("persists encrypted named secrets without exposing the raw value in snapshots", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-secret-vault-"));
    const vaultPath = path.join(tempDir, "vault.json");

    try {
      const vault = new SecretVault({
        vaultPath,
        safeStorage: fakeSafeStorage,
      });

      const snapshot = vault.saveNamedSecret({
        key: "my stripe api key",
        value: "sk-live-123",
      });
      const persisted = readFileSync(vaultPath, "utf8");

      expect(snapshot.secrets).toEqual([
        expect.objectContaining({
          key: "my stripe api key",
        }),
      ]);
      expect(persisted).not.toContain("sk-live-123");
      expect(persisted).toContain(Buffer.from("encrypted:sk-live-123", "utf8").toString("base64"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes named secrets from the vault snapshot", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-secret-vault-"));
    const vaultPath = path.join(tempDir, "vault.json");

    try {
      const vault = new SecretVault({
        vaultPath,
        safeStorage: fakeSafeStorage,
      });

      const savedSnapshot = vault.saveNamedSecret({
        key: "my stripe api key",
        value: "sk-live-123",
      });
      const secretId = savedSnapshot.secrets[0]?.id;
      expect(secretId).toBeDefined();

      const nextSnapshot = vault.deleteNamedSecret({
        id: secretId!,
      });

      expect(nextSnapshot.secrets).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
