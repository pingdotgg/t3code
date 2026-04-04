import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  VaultSecretDeleteInput,
  VaultSecretId,
  VaultSecretSummary,
  VaultSecretsSnapshot,
  VaultSecretUpsertInput,
} from "@t3tools/contracts";
import { VaultSecretId as VaultSecretIdSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface NamedSecretVaultRecord {
  key: string;
  ciphertext: string;
  updatedAt: string;
}

interface LegacyVaultFileV1 {
  version: 1;
  materials: Record<string, unknown>;
}

interface LegacyVaultFileV2 {
  version: 2;
  materials: Record<string, unknown>;
  namedSecrets: Record<string, NamedSecretVaultRecord>;
}

interface LegacyVaultFileV3 {
  version: 3;
  materials: Record<string, unknown>;
  namedSecrets: Record<string, NamedSecretVaultRecord>;
  verificationStates: Record<string, unknown>;
}

interface VaultFileV4 {
  version: 4;
  namedSecrets: Record<string, NamedSecretVaultRecord>;
}

type SecretVaultFile = LegacyVaultFileV1 | LegacyVaultFileV2 | LegacyVaultFileV3 | VaultFileV4;

const SECRET_VAULT_VERSION = 4 as const;

function createEmptyVaultFile(): VaultFileV4 {
  return {
    version: SECRET_VAULT_VERSION,
    namedSecrets: {},
  };
}

function toNamedSecretSummary(
  secretId: VaultSecretId,
  record: NamedSecretVaultRecord,
): VaultSecretSummary {
  return {
    id: secretId,
    key: record.key,
    updatedAt: record.updatedAt,
  };
}

function normalizeVaultKey(key: string): string {
  return key.trim().toLocaleLowerCase();
}

function isNamedSecretVaultRecord(value: unknown): value is NamedSecretVaultRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "key") === "string" &&
    typeof Reflect.get(value, "ciphertext") === "string" &&
    typeof Reflect.get(value, "updatedAt") === "string"
  );
}

export class SecretVault {
  private readonly listeners = new Set<() => void>();
  private readonly namedSecrets = new Map<VaultSecretId, NamedSecretVaultRecord>();
  private loaded = false;

  constructor(
    private readonly options: {
      vaultPath: string;
      legacyVaultPaths?: readonly string[];
      safeStorage: SafeStorageLike;
    },
  ) {}

  isAvailable(): boolean {
    return this.options.safeStorage.isEncryptionAvailable();
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listNamedSecrets(): VaultSecretsSnapshot {
    this.ensureLoaded();
    if (!this.isAvailable()) {
      return {
        enabled: false,
        safeStorageAvailable: false,
        message: "Secure secret storage is unavailable on this device.",
        secrets: [],
      };
    }

    return {
      enabled: true,
      safeStorageAvailable: true,
      message: null,
      secrets: [...this.namedSecrets.entries()]
        .toSorted((left, right) => left[1].key.localeCompare(right[1].key))
        .map(([secretId, record]) => toNamedSecretSummary(secretId, record)),
    };
  }

  getNamedSecret(secretId: VaultSecretId): VaultSecretSummary | null {
    this.ensureLoaded();
    const record = this.namedSecrets.get(secretId);
    if (!record) {
      return null;
    }
    return toNamedSecretSummary(secretId, record);
  }

  saveNamedSecret(input: VaultSecretUpsertInput): VaultSecretsSnapshot {
    this.ensureAvailable();
    this.ensureLoaded();

    const existingEntry = input.id ? this.namedSecrets.get(input.id) : undefined;
    if (!existingEntry && input.value === undefined) {
      throw new Error("A new vault secret requires a value.");
    }

    const normalizedKey = normalizeVaultKey(input.key);
    for (const [secretId, record] of this.namedSecrets) {
      if (input.id && secretId === input.id) {
        continue;
      }
      if (normalizeVaultKey(record.key) === normalizedKey) {
        throw new Error(`A vault secret named "${input.key}" already exists.`);
      }
    }

    const nextSecretId =
      input.id ??
      Schema.decodeUnknownSync(VaultSecretIdSchema)(`vault_secret_${crypto.randomUUID()}`);
    const nextValue = input.value ?? this.getNamedSecretValue(nextSecretId);
    if (nextValue === null) {
      throw new Error("Stored vault secret material could not be loaded.");
    }

    const nextRecord: NamedSecretVaultRecord = {
      key: input.key,
      ciphertext: this.options.safeStorage.encryptString(nextValue).toString("base64"),
      updatedAt: input.value !== undefined ? new Date().toISOString() : existingEntry!.updatedAt,
    };

    this.namedSecrets.set(nextSecretId, nextRecord);
    this.persist();
    this.emitChange();
    return this.listNamedSecrets();
  }

  deleteNamedSecret(input: VaultSecretDeleteInput): VaultSecretsSnapshot {
    this.ensureLoaded();
    const changed = this.namedSecrets.delete(input.id);
    if (changed) {
      this.persist();
      this.emitChange();
    }
    return this.listNamedSecrets();
  }

  private getNamedSecretValue(secretId: VaultSecretId): string | null {
    this.ensureAvailable();
    this.ensureLoaded();

    const record = this.namedSecrets.get(secretId);
    if (!record) {
      return null;
    }

    try {
      return this.options.safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"));
    } catch {
      throw new Error("Stored vault secret material could not be decrypted.");
    }
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private ensureAvailable(): void {
    if (this.isAvailable()) {
      return;
    }
    throw new Error("Secure secret storage is unavailable on this device.");
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    const candidatePaths = [
      this.options.vaultPath,
      ...(this.options.legacyVaultPaths ?? []),
    ].filter((candidatePath, index, paths) => paths.indexOf(candidatePath) === index);

    const existingVaultPath = candidatePaths.find((candidatePath) => FS.existsSync(candidatePath));
    if (!existingVaultPath) {
      return;
    }

    try {
      const raw = FS.readFileSync(existingVaultPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SecretVaultFile>;
      if (
        parsed.version !== 1 &&
        parsed.version !== 2 &&
        parsed.version !== 3 &&
        parsed.version !== SECRET_VAULT_VERSION
      ) {
        throw new Error("Unsupported vault file version.");
      }

      if (
        (parsed.version === 2 || parsed.version === 3 || parsed.version === SECRET_VAULT_VERSION) &&
        parsed.namedSecrets
      ) {
        for (const [secretId, record] of Object.entries(parsed.namedSecrets)) {
          if (typeof secretId !== "string" || !isNamedSecretVaultRecord(record)) {
            continue;
          }

          this.namedSecrets.set(secretId as VaultSecretId, {
            key: record.key,
            ciphertext: record.ciphertext,
            updatedAt: record.updatedAt,
          });
        }
      }
    } catch {
      throw new Error("Secret vault data is unreadable.");
    }
  }

  private persist(): void {
    const vaultFile = createEmptyVaultFile();
    for (const [secretId, record] of this.namedSecrets) {
      vaultFile.namedSecrets[secretId] = record;
    }

    FS.mkdirSync(Path.dirname(this.options.vaultPath), { recursive: true });
    const tempPath = `${this.options.vaultPath}.${process.pid}.${Date.now()}.tmp`;
    FS.writeFileSync(tempPath, `${JSON.stringify(vaultFile, null, 2)}\n`, "utf8");
    FS.renameSync(tempPath, this.options.vaultPath);
  }
}
