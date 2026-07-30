import * as FS from "node:fs";
import * as Path from "node:path";

import {
  ClientSettingsSchema,
  type ClientSettings,
  type PersistedSavedEnvironmentRecord,
} from "@t3tools/contracts";
import { Predicate } from "effect";
import * as Schema from "effect/Schema";

interface ClientSettingsDocument {
  readonly settings: ClientSettings;
}

interface PersistedSavedEnvironmentStorageRecord extends PersistedSavedEnvironmentRecord {
  readonly encryptedBearerToken?: string;
}

interface SavedEnvironmentRegistryDocument {
  readonly records: readonly PersistedSavedEnvironmentStorageRecord[];
}

export interface DesktopSecretStorage {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!FS.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(FS.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  const directory = Path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(directory, { recursive: true });
  FS.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  FS.renameSync(tempPath, filePath);
}

function isPersistedSavedEnvironmentStorageRecord(
  value: unknown,
): value is PersistedSavedEnvironmentStorageRecord {
  return (
    Predicate.isObject(value) &&
    typeof value.environmentId === "string" &&
    typeof value.label === "string" &&
    typeof value.httpBaseUrl === "string" &&
    typeof value.wsBaseUrl === "string" &&
    typeof value.createdAt === "string" &&
    (value.lastConnectedAt === null || typeof value.lastConnectedAt === "string") &&
    (value.encryptedBearerToken === undefined || typeof value.encryptedBearerToken === "string")
  );
}

function readSavedEnvironmentRegistryDocument(filePath: string): SavedEnvironmentRegistryDocument {
  const parsed = readJsonFile<SavedEnvironmentRegistryDocument>(filePath);
  if (!Predicate.isObject(parsed)) {
    return { records: [] };
  }

  return {
    records: Array.isArray(parsed.records)
      ? parsed.records.filter(isPersistedSavedEnvironmentStorageRecord)
      : [],
  };
}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentStorageRecord,
): PersistedSavedEnvironmentRecord {
  return {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
}

export function readClientSettings(settingsPath: string): ClientSettings | null {
  const raw = readJsonFile<ClientSettingsDocument>(settingsPath)?.settings;
  if (!raw) {
    return null;
  }
  try {
    return Schema.decodeUnknownSync(ClientSettingsSchema)(raw);
  } catch {
    return null;
  }
}

export function writeClientSettings(settingsPath: string, settings: ClientSettings): void {
  writeJsonFile(settingsPath, { settings } satisfies ClientSettingsDocument);
}

export function readSavedEnvironmentRegistry(
  registryPath: string,
): readonly PersistedSavedEnvironmentRecord[] {
  return readSavedEnvironmentRegistryDocument(registryPath).records.map((record) =>
    toPersistedSavedEnvironmentRecord(record),
  );
}

export function writeSavedEnvironmentRegistry(
  registryPath: string,
  records: readonly PersistedSavedEnvironmentRecord[],
): void {
  const currentDocument = readSavedEnvironmentRegistryDocument(registryPath);
  const encryptedBearerTokenById = new Map(
    currentDocument.records.flatMap((record) =>
      record.encryptedBearerToken
        ? [[record.environmentId, record.encryptedBearerToken] as const]
        : [],
    ),
  );
  writeJsonFile(registryPath, {
    records: records.map((record) => {
      const encryptedBearerToken = encryptedBearerTokenById.get(record.environmentId);
      return encryptedBearerToken
        ? {
            environmentId: record.environmentId,
            label: record.label,
            httpBaseUrl: record.httpBaseUrl,
            wsBaseUrl: record.wsBaseUrl,
            createdAt: record.createdAt,
            lastConnectedAt: record.lastConnectedAt,
            encryptedBearerToken,
          }
        : record;
    }),
  } satisfies SavedEnvironmentRegistryDocument);
}

export function readSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
  readonly secretStorage: DesktopSecretStorage;
}): string | null {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);
  const encoded = document.records.find(
    (record) => record.environmentId === input.environmentId,
  )?.encryptedBearerToken;
  if (!encoded) {
    return null;
  }

  if (!input.secretStorage.isEncryptionAvailable()) {
    return null;
  }

  try {
    return input.secretStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

export function writeSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
  readonly secret: string;
  readonly secretStorage: DesktopSecretStorage;
}): boolean {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);

  if (!input.secretStorage.isEncryptionAvailable()) {
    return false;
  }

  let found = false;

  writeJsonFile(input.registryPath, {
    records: document.records.map((record) => {
      if (record.environmentId !== input.environmentId) {
        return record;
      }

      found = true;
      const encryptedBearerToken = input.secretStorage
        .encryptString(input.secret)
        .toString("base64");
      return {
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
        createdAt: record.createdAt,
        lastConnectedAt: record.lastConnectedAt,
        encryptedBearerToken,
      } satisfies PersistedSavedEnvironmentStorageRecord;
    }),
  } satisfies SavedEnvironmentRegistryDocument);
  return found;
}

export function removeSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
}): void {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);
  if (
    !document.records.some(
      (record) =>
        record.environmentId === input.environmentId && record.encryptedBearerToken !== undefined,
    )
  ) {
    return;
  }

  writeJsonFile(input.registryPath, {
    records: document.records.map((record) => {
      if (record.environmentId !== input.environmentId) {
        return record;
      }

      return toPersistedSavedEnvironmentRecord(record);
    }),
  } satisfies SavedEnvironmentRegistryDocument);
}
