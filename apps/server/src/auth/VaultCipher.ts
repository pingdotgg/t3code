// @effect-diagnostics nodeBuiltinImport:off - Node provides AES-GCM and the bounded lookup in the local OS keyring.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

export const vaultMarker = "vault-linux-keyring-v1";
const header = Buffer.from("HYAKKI-VAULT-1\0");
const nonceSize = 12;
const tagSize = 16;
const keyringBinary = "/usr/bin/secret-tool";

export const vaultKeyringAttributes = (directory: string) => [
  "application",
  "dev.ryoku.Hyakki",
  "vault",
  NodeCrypto.createHash("sha256").update(directory).digest("hex"),
];

export function readVaultKey(directory: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      keyringBinary,
      ["lookup", ...vaultKeyringAttributes(directory)],
      { timeout: 5000, maxBuffer: 4096 },
      (error, stdout) => {
        const value = stdout.trim();
        if (error || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
          reject(
            new Error("Hyakki vault key unavailable. Unlock the Linux keyring and try again."),
          );
          return;
        }
        resolve(Buffer.from(value, "base64"));
      },
    );
  });
}

export function isVaultCiphertext(value: Uint8Array): boolean {
  return Buffer.from(value.subarray(0, header.length)).equals(header);
}

export function sealVaultValue(key: Uint8Array, name: string, value: Uint8Array): Buffer {
  const nonce = NodeCrypto.randomBytes(nonceSize);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([header, nonce, cipher.getAuthTag(), ciphertext]);
}

export function openVaultValue(key: Uint8Array, name: string, value: Uint8Array): Buffer {
  const start = header.length;
  if (!isVaultCiphertext(value) || value.length < start + nonceSize + tagSize) {
    throw new Error(
      "Invalid Hyakki vault record. Complete the local vault migration before starting Hyakki.",
    );
  }
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key,
    value.subarray(start, start + nonceSize),
  );
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(value.subarray(start + nonceSize, start + nonceSize + tagSize));
  return Buffer.concat([
    decipher.update(value.subarray(start + nonceSize + tagSize)),
    decipher.final(),
  ]);
}
