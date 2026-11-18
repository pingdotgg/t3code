// @effect-diagnostics nodeBuiltinImport:off -- Pure Node crypto and file helpers that run before the app's services exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Safe storage across a rename: macOS keys `safeStorage` by "<app name> Safe Storage" from
 * the startup name. When a rename changes that key, this reads the old key from the keychain,
 * decrypts the secrets in Node and encrypts them again with the new key.
 */

const V10_PREFIX = Buffer.from("v10");
const IV = Buffer.alloc(16, 0x20);

/** Chromium's macOS key: PBKDF2-SHA1 over the keychain password, salt "saltysalt", 1003 rounds. */
function deriveKey(password: string): Buffer {
  return NodeCrypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

export function encryptChromiumV10(plaintext: string, password: string): Buffer {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", deriveKey(password), IV);
  return Buffer.concat([V10_PREFIX, cipher.update(plaintext, "utf8"), cipher.final()]);
}

/** Throws when the data is not `v10` or the key is wrong (the padding check fails). */
export function decryptChromiumV10(ciphertext: Uint8Array, password: string): string {
  const bytes = Buffer.from(ciphertext);
  if (!bytes.subarray(0, V10_PREFIX.length).equals(V10_PREFIX)) {
    throw new Error("Not a Chromium v10 value.");
  }
  const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", deriveKey(password), IV);
  return Buffer.concat([
    decipher.update(bytes.subarray(V10_PREFIX.length)),
    decipher.final(),
  ]).toString("utf8");
}

/** Keychain items an earlier build may have kept its key in, most likely first. */
export function legacyKeychainServices(isDevelopment: boolean): readonly string[] {
  const packaged = "t3code Safe Storage";
  const electronDefault = "Electron Safe Storage";
  // oxlint-disable-next-line t3code/no-hardcoded-app-name -- legacy upstream Safe Storage keychain names, matched as they were written
  const stageNamed = isDevelopment ? "T3 Code (Dev) Safe Storage" : "T3 Code (Alpha) Safe Storage";
  return isDevelopment
    ? [electronDefault, packaged, stageNamed]
    : [packaged, electronDefault, stageNamed];
}

/**
 * Reads a keychain password. macOS may ask the user once to allow it. Null when the
 * item is missing or the user declines.
 */
export function readKeychainPassword(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service],
      { encoding: "utf8", timeout: 120_000 },
      (error, stdout) => resolve(error ? null : stdout.replace(/\r?\n$/, "")),
    );
  });
}

export interface SecretReencryptionResult {
  readonly examined: number;
  readonly alreadyCurrent: number;
  readonly reencrypted: number;
  readonly failed: number;
}

interface SecretField {
  readonly read: () => string | undefined;
  readonly write: (value: string) => void;
}

/** The base64 fields that hold safeStorage ciphertext in the state files, and how to reach them. */
function secretFieldsOf(fileName: string, document: unknown): SecretField[] {
  if (typeof document !== "object" || document === null) return [];
  const object = document as Record<string, unknown>;
  if (fileName === "connection-catalog.json") {
    return [
      {
        read: () =>
          typeof object.encryptedCatalog === "string" ? object.encryptedCatalog : undefined,
        write: (value) => {
          object.encryptedCatalog = value;
        },
      },
    ];
  }
  if (fileName === "saved-environments.json" && Array.isArray(object.records)) {
    return object.records.flatMap((record: unknown): SecretField[] =>
      typeof record === "object" && record !== null
        ? [
            {
              read: () =>
                typeof (record as Record<string, unknown>).encryptedBearerToken === "string"
                  ? ((record as Record<string, unknown>).encryptedBearerToken as string)
                  : undefined,
              write: (value) => {
                (record as Record<string, unknown>).encryptedBearerToken = value;
              },
            },
          ]
        : [],
    );
  }
  return [];
}

const SECRET_STATE_FILES = ["connection-catalog.json", "saved-environments.json"] as const;
export const PRE_RENAME_BACKUP_SUFFIX = ".before-rename";

/**
 * Re-encrypts the state files' secrets that the current safeStorage key cannot
 * read, using the old key. A value the current key reads is left alone, so this
 * does nothing in the normal case. The first rewrite of a file keeps the original
 * next to it as `<name>.before-rename`.
 */
export async function reencryptLegacySecrets(input: {
  readonly stateDir: string;
  /** Throws when the current key cannot decrypt the bytes. */
  readonly decryptCurrent: (ciphertext: Uint8Array) => string;
  readonly encryptCurrent: (plaintext: string) => Uint8Array;
  /** Old keychain passwords to try, read only when a value needs them. */
  readonly legacyPasswords: () => Promise<readonly string[]>;
}): Promise<SecretReencryptionResult> {
  let examined = 0;
  let alreadyCurrent = 0;
  let reencrypted = 0;
  let failed = 0;
  let passwords: readonly string[] | null = null;

  for (const fileName of SECRET_STATE_FILES) {
    const filePath = NodePath.join(input.stateDir, fileName);
    let raw: string;
    try {
      raw = NodeFS.readFileSync(filePath, "utf8");
    } catch (error) {
      // A missing file has nothing to re-encrypt. A file that exists but cannot be read is a
      // failure, so the next launch tries again.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed += 1;
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      failed += 1;
      continue;
    }

    let changed = false;
    for (const field of secretFieldsOf(fileName, document)) {
      const encoded = field.read();
      if (encoded === undefined) continue;
      examined += 1;
      const bytes = Buffer.from(encoded, "base64");
      try {
        input.decryptCurrent(bytes);
        alreadyCurrent += 1;
        continue;
      } catch {
        // The current key cannot read it. Try the old keys.
      }
      passwords ??= await input.legacyPasswords();
      let plaintext: string | null = null;
      for (const password of passwords) {
        try {
          plaintext = decryptChromiumV10(bytes, password);
          break;
        } catch {
          // Wrong key. Try the next one.
        }
      }
      if (plaintext === null) {
        failed += 1;
        continue;
      }
      field.write(Buffer.from(input.encryptCurrent(plaintext)).toString("base64"));
      reencrypted += 1;
      changed = true;
    }

    if (changed) {
      const backupPath = `${filePath}${PRE_RENAME_BACKUP_SUFFIX}`;
      if (!NodeFS.existsSync(backupPath)) NodeFS.writeFileSync(backupPath, raw, { flag: "wx" });
      const tempPath = `${filePath}.${process.pid}.tmp`;
      NodeFS.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`);
      NodeFS.renameSync(tempPath, filePath);
    }
  }

  return { examined, alreadyCurrent, reencrypted, failed };
}
