import {
  AntigravityAccountError,
  AntigravityAccountId,
  AntigravitySettings,
  type AntigravityAccountDetection,
  type AntigravityAccountRecord,
  type AntigravityAccountsRegistry,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import {
  antigravityLanguageServerRpc,
  detectAntigravityDaemonEnvironment,
  resolveAntigravityAgentApiPath,
} from "./Layers/AntigravityProvider.ts";

const REGISTRY_FILE_NAME = "registry.json";
const SNAPSHOT_DIR_NAME = "snapshot";

/** Auth-critical paths under the Antigravity credentials directory (~/.gemini), relative to its root. */
export const ANTIGRAVITY_AUTH_RELATIVE_PATHS = [
  "antigravity-browser-profile",
  "antigravity/implicit",
  "antigravity/installation_id",
  "antigravity-cli/installation_id",
] as const;

const AntigravityAccountsRegistrySchema = Schema.Struct({
  activeAccountId: Schema.optional(AntigravityAccountId),
  dismissedFingerprints: Schema.Array(Schema.String),
  accounts: Schema.Array(
    Schema.Struct({
      id: AntigravityAccountId,
      label: Schema.String,
      fingerprint: Schema.String,
      email: Schema.optional(Schema.String),
      createdAt: Schema.String,
      lastUsedAt: Schema.optional(Schema.String),
    }),
  ),
});

const decodeRegistryJson = Schema.decodeEffect(
  Schema.fromJsonString(AntigravityAccountsRegistrySchema),
);
const encodeRegistry = Schema.encodeUnknownEffect(
  fromJsonStringPretty(AntigravityAccountsRegistrySchema),
);

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

export function resolveAntigravitySettingsFromServer(
  settings: ServerSettings,
): AntigravitySettings {
  const instance = Object.values(settings.providerInstances).find(
    (entry) => entry.driver === "antigravity",
  );
  if (instance?.config != null) {
    return decodeAntigravitySettings(instance.config);
  }
  return settings.providers.antigravity;
}

export function resolveAntigravityGeminiHomePath(settings?: AntigravitySettings): string {
  const resolved = settings ?? decodeAntigravitySettings({});
  const configured = resolved.geminiHomePath?.trim();
  if (configured) {
    return expandHomePath(configured);
  }
  return expandHomePath("~/.gemini");
}

function accountStoreRoot(stateDir: string): string {
  return `${stateDir}/antigravity-accounts`;
}

function registryPath(stateDir: string): string {
  return `${accountStoreRoot(stateDir)}/${REGISTRY_FILE_NAME}`;
}

function accountSnapshotRoot(stateDir: string, accountId: AntigravityAccountId): string {
  return `${accountStoreRoot(stateDir)}/${accountId}/${SNAPSHOT_DIR_NAME}`;
}

const readTextFileIfExists = Effect.fn("AntigravityAccountStore.readTextFileIfExists")(function* (
  filePath: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(filePath).pipe(
    Effect.map((contents) => contents.trim()),
    Effect.orElseSucceed(() => undefined),
  );
});

export const readAntigravityAccountFingerprint = Effect.fn("readAntigravityAccountFingerprint")(
  function* (
    geminiHome: string,
  ): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const parts: string[] = [];
    for (const relativePath of [
      "antigravity/installation_id",
      "antigravity-cli/installation_id",
    ] as const) {
      const value = yield* readTextFileIfExists(path.join(geminiHome, relativePath));
      if (value) {
        parts.push(value);
      }
    }
    if (parts.length === 0) {
      const browserProfile = path.join(geminiHome, "antigravity-browser-profile");
      const exists = yield* fileSystem
        .exists(browserProfile)
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        parts.push("browser-profile");
      }
    }
    return parts.length > 0 ? parts.join(":") : undefined;
  },
);

const pathExists = Effect.fn("AntigravityAccountStore.pathExists")(function* (
  targetPath: string,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => false));
});

const copyPathRecursive = Effect.fn("AntigravityAccountStore.copyPathRecursive")(function* (input: {
  readonly from: string;
  readonly to: string;
}): Effect.fn.Return<void, AntigravityAccountError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* pathExists(input.from);
  if (!exists) {
    return;
  }

  const stat = yield* fileSystem.stat(input.from).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityAccountError({
          detail: `Failed to inspect '${input.from}' while copying Antigravity credentials.`,
          cause,
        }),
    ),
  );

  if (stat.type === "File") {
    yield* fileSystem.makeDirectory(path.dirname(input.to), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AntigravityAccountError({
            detail: `Failed to create parent directory for '${input.to}'.`,
            cause,
          }),
      ),
    );
    const contents = yield* fileSystem.readFile(input.from).pipe(
      Effect.mapError(
        (cause) =>
          new AntigravityAccountError({
            detail: `Failed to read '${input.from}'.`,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(input.to, contents).pipe(
      Effect.mapError(
        (cause) =>
          new AntigravityAccountError({
            detail: `Failed to write '${input.to}'.`,
            cause,
          }),
      ),
    );
    return;
  }

  if (stat.type === "Directory") {
    yield* fileSystem.makeDirectory(input.to, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AntigravityAccountError({
            detail: `Failed to create directory '${input.to}'.`,
            cause,
          }),
      ),
    );
    const entries = yield* fileSystem.readDirectory(input.from).pipe(
      Effect.mapError(
        (cause) =>
          new AntigravityAccountError({
            detail: `Failed to list '${input.from}'.`,
            cause,
          }),
      ),
    );
    yield* Effect.forEach(
      entries,
      (entry) =>
        copyPathRecursive({
          from: path.join(input.from, entry),
          to: path.join(input.to, entry),
        }),
      { discard: true },
    );
  }
});

const removePathRecursive = Effect.fn("AntigravityAccountStore.removePathRecursive")(function* (
  targetPath: string,
): Effect.fn.Return<void, AntigravityAccountError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* pathExists(targetPath);
  if (!exists) {
    return;
  }

  const stat = yield* fileSystem.stat(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityAccountError({
          detail: `Failed to inspect '${targetPath}' while removing Antigravity credentials.`,
          cause,
        }),
    ),
  );

  if (stat.type === "File") {
    yield* fileSystem.remove(targetPath).pipe(
      Effect.mapError(
        (cause) =>
          new AntigravityAccountError({
            detail: `Failed to remove file '${targetPath}'.`,
            cause,
          }),
      ),
    );
    return;
  }

  if (stat.type === "Directory") {
    yield* fileSystem.remove(targetPath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AntigravityAccountError({
            detail: `Failed to remove directory '${targetPath}'.`,
            cause,
          }),
      ),
    );
  }
});

const snapshotAuthPaths = Effect.fn("AntigravityAccountStore.snapshotAuthPaths")(function* (input: {
  readonly geminiHome: string;
  readonly destinationRoot: string;
}): Effect.fn.Return<void, AntigravityAccountError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  yield* Effect.forEach(
    ANTIGRAVITY_AUTH_RELATIVE_PATHS,
    (relativePath) =>
      copyPathRecursive({
        from: path.join(input.geminiHome, relativePath),
        to: path.join(input.destinationRoot, relativePath),
      }),
    { discard: true },
  );
});

const restoreAuthPaths = Effect.fn("AntigravityAccountStore.restoreAuthPaths")(function* (input: {
  readonly geminiHome: string;
  readonly sourceRoot: string;
}): Effect.fn.Return<void, AntigravityAccountError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  yield* Effect.forEach(
    ANTIGRAVITY_AUTH_RELATIVE_PATHS,
    (relativePath) => {
      const target = path.join(input.geminiHome, relativePath);
      return Effect.gen(function* () {
        yield* removePathRecursive(target);
        yield* copyPathRecursive({
          from: path.join(input.sourceRoot, relativePath),
          to: target,
        });
      });
    },
    { discard: true },
  );
});

const clearAuthPaths = Effect.fn("AntigravityAccountStore.clearAuthPaths")(function* (
  geminiHome: string,
): Effect.fn.Return<void, AntigravityAccountError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  yield* Effect.forEach(
    ANTIGRAVITY_AUTH_RELATIVE_PATHS,
    (relativePath) => removePathRecursive(path.join(geminiHome, relativePath)),
    { discard: true },
  );
});

const readRegistry = Effect.fn("AntigravityAccountStore.readRegistry")(function* (
  stateDir: string,
): Effect.fn.Return<AntigravityAccountsRegistry, AntigravityAccountError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const filePath = registryPath(stateDir);
  const exists = yield* pathExists(filePath);
  if (!exists) {
    return { accounts: [], dismissedFingerprints: [] };
  }

  const contents = yield* fileSystem.readFileString(filePath).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityAccountError({
          detail: "Failed to read Antigravity account registry.",
          cause,
        }),
    ),
  );
  return yield* decodeRegistryJson(contents).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityAccountError({
          detail: "Antigravity account registry is invalid.",
          cause,
        }),
    ),
  );
});

const writeRegistry = Effect.fn("AntigravityAccountStore.writeRegistry")(function* (
  stateDir: string,
  registry: AntigravityAccountsRegistry,
): Effect.fn.Return<void, AntigravityAccountError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const filePath = registryPath(stateDir);
  yield* fileSystem.makeDirectory(accountStoreRoot(stateDir), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityAccountError({
          detail: "Failed to create Antigravity account store directory.",
          cause,
        }),
    ),
  );
  const encoded = yield* encodeRegistry(registry).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityAccountError({
          detail: "Failed to encode Antigravity account registry.",
          cause,
        }),
    ),
  );
  yield* fileSystem.writeFileString(filePath, encoded).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityAccountError({
          detail: "Failed to write Antigravity account registry.",
          cause,
        }),
    ),
  );
});

const fetchAuthStatus = Effect.fn("AntigravityAccountStore.fetchAuthStatus")(function* (
  settings: AntigravitySettings,
): Effect.fn.Return<{ readonly authenticated: boolean; readonly email?: string }, never, never> {
  const binaryPath = resolveAntigravityAgentApiPath(settings);
  const detected = detectAntigravityDaemonEnvironment(binaryPath, process.env);
  const address = detected.ANTIGRAVITY_LS_ADDRESS;
  if (!address) {
    return { authenticated: false };
  }

  return yield* Effect.tryPromise({
    try: async () => {
      const response = (await antigravityLanguageServerRpc({
        endpoint: {
          address,
          csrfToken: detected.ANTIGRAVITY_CSRF_TOKEN,
        },
        method: "GetAuthStatus",
        body: {},
      })) as {
        readonly authResult?: {
          readonly hasValidAuth?: boolean;
          readonly email?: string;
          readonly userEmail?: string;
        };
      };
      const authResult = response.authResult;
      const email = authResult?.email ?? authResult?.userEmail;
      return {
        authenticated: authResult?.hasValidAuth === true,
        ...(email?.trim() ? { email: email.trim() } : {}),
      };
    },
    catch: (cause) =>
      new AntigravityAccountError({
        detail: "Antigravity auth status probe failed.",
        cause,
      }),
  }).pipe(Effect.orElseSucceed(() => ({ authenticated: false })));
});

const buildDetection = Effect.fn("AntigravityAccountStore.buildDetection")(function* (input: {
  readonly registry: AntigravityAccountsRegistry;
  readonly settings: AntigravitySettings;
}): Effect.fn.Return<
  AntigravityAccountDetection,
  AntigravityAccountError,
  FileSystem.FileSystem | Path.Path
> {
  const geminiHome = resolveAntigravityGeminiHomePath(input.settings);
  const fingerprint = (yield* readAntigravityAccountFingerprint(geminiHome)) ?? "unknown";
  const matched = input.registry.accounts.find((account) => account.fingerprint === fingerprint);
  const auth = yield* fetchAuthStatus(input.settings);
  return {
    fingerprint,
    authenticated: auth.authenticated,
    ...(auth.email ? { email: auth.email } : {}),
    isKnown: matched !== undefined,
    isDismissed: input.registry.dismissedFingerprints.includes(fingerprint),
    ...(input.registry.activeAccountId ? { activeAccountId: input.registry.activeAccountId } : {}),
    ...(matched ? { matchedAccountId: matched.id } : {}),
  };
});

function defaultAccountLabel(input: {
  readonly email?: string;
  readonly fingerprint: string;
  readonly existingCount: number;
}): string {
  if (input.email?.trim()) {
    return input.email.trim();
  }
  const suffix = input.fingerprint.slice(0, 8);
  return input.existingCount === 0 ? "Antigravity account" : `Antigravity account (${suffix})`;
}

export const listAntigravityAccounts = Effect.fn("listAntigravityAccounts")(function* (
  settings: AntigravitySettings,
): Effect.fn.Return<
  {
    readonly registry: AntigravityAccountsRegistry;
    readonly detection: AntigravityAccountDetection;
  },
  AntigravityAccountError,
  ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const registry = yield* readRegistry(serverConfig.stateDir);
  const detection = yield* buildDetection({ registry, settings });
  return { registry, detection };
});

export const detectAntigravityAccount = Effect.fn("detectAntigravityAccount")(function* (
  settings: AntigravitySettings,
): Effect.fn.Return<
  AntigravityAccountDetection,
  AntigravityAccountError,
  ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const registry = yield* readRegistry(serverConfig.stateDir);
  return yield* buildDetection({ registry, settings });
});

export const saveAntigravityAccount = Effect.fn("saveAntigravityAccount")(function* (input: {
  readonly settings: AntigravitySettings;
  readonly label?: string;
}): Effect.fn.Return<
  AntigravityAccountsRegistry,
  AntigravityAccountError,
  ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> {
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const geminiHome = resolveAntigravityGeminiHomePath(input.settings);
  const fingerprint = yield* readAntigravityAccountFingerprint(geminiHome);
  if (!fingerprint) {
    return yield* new AntigravityAccountError({
      detail: "No Antigravity credentials were found to save.",
    });
  }

  let registry = yield* readRegistry(serverConfig.stateDir);
  const existing = registry.accounts.find((account) => account.fingerprint === fingerprint);
  if (existing) {
    registry = {
      ...registry,
      activeAccountId: existing.id,
    };
    yield* writeRegistry(serverConfig.stateDir, registry);
    return registry;
  }

  const auth = yield* fetchAuthStatus(input.settings);
  const accountId = AntigravityAccountId.make(
    yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new AntigravityAccountError({
            detail: "Failed to allocate Antigravity account id.",
            cause,
          }),
      ),
    ),
  );
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const record: AntigravityAccountRecord = {
    id: accountId,
    label:
      input.label?.trim() ||
      defaultAccountLabel({
        ...(auth.email ? { email: auth.email } : {}),
        fingerprint,
        existingCount: registry.accounts.length,
      }),
    fingerprint,
    createdAt,
    lastUsedAt: createdAt,
    ...(auth.email ? { email: auth.email } : {}),
  };

  yield* snapshotAuthPaths({
    geminiHome,
    destinationRoot: accountSnapshotRoot(serverConfig.stateDir, accountId),
  });

  registry = {
    ...registry,
    activeAccountId: accountId,
    accounts: [...registry.accounts, record],
  };
  yield* writeRegistry(serverConfig.stateDir, registry);
  return registry;
});

export const switchAntigravityAccount = Effect.fn("switchAntigravityAccount")(function* (input: {
  readonly settings: AntigravitySettings;
  readonly accountId: AntigravityAccountId;
}): Effect.fn.Return<
  AntigravityAccountsRegistry,
  AntigravityAccountError,
  ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const geminiHome = resolveAntigravityGeminiHomePath(input.settings);
  let registry = yield* readRegistry(serverConfig.stateDir);
  const target = registry.accounts.find((account) => account.id === input.accountId);
  if (!target) {
    return yield* new AntigravityAccountError({
      detail: `Antigravity account '${input.accountId}' was not found.`,
    });
  }

  if (registry.activeAccountId) {
    const active = registry.accounts.find((account) => account.id === registry.activeAccountId);
    if (active) {
      yield* snapshotAuthPaths({
        geminiHome,
        destinationRoot: accountSnapshotRoot(serverConfig.stateDir, active.id),
      });
    }
  }

  yield* clearAuthPaths(geminiHome);
  yield* restoreAuthPaths({
    geminiHome,
    sourceRoot: accountSnapshotRoot(serverConfig.stateDir, target.id),
  });

  const lastUsedAt = DateTime.formatIso(yield* DateTime.now);
  registry = {
    ...registry,
    activeAccountId: target.id,
    accounts: registry.accounts.map((account) =>
      account.id === target.id ? { ...account, lastUsedAt } : account,
    ),
  };
  yield* writeRegistry(serverConfig.stateDir, registry);
  return registry;
});

export const removeAntigravityAccount = Effect.fn("removeAntigravityAccount")(function* (input: {
  readonly accountId: AntigravityAccountId;
}): Effect.fn.Return<
  AntigravityAccountsRegistry,
  AntigravityAccountError,
  ServerConfig | FileSystem.FileSystem
> {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  let registry = yield* readRegistry(serverConfig.stateDir);
  const exists = registry.accounts.some((account) => account.id === input.accountId);
  if (!exists) {
    return yield* new AntigravityAccountError({
      detail: `Antigravity account '${input.accountId}' was not found.`,
    });
  }

  const accountDir = `${accountStoreRoot(serverConfig.stateDir)}/${input.accountId}`;
  yield* fileSystem.remove(accountDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

  registry = {
    ...registry,
    activeAccountId:
      registry.activeAccountId === input.accountId ? undefined : registry.activeAccountId,
    accounts: registry.accounts.filter((account) => account.id !== input.accountId),
  };
  yield* writeRegistry(serverConfig.stateDir, registry);
  return registry;
});

export const dismissDetectedAntigravityAccount = Effect.fn("dismissDetectedAntigravityAccount")(
  function* (input: {
    readonly fingerprint: string;
  }): Effect.fn.Return<
    AntigravityAccountsRegistry,
    AntigravityAccountError,
    ServerConfig | FileSystem.FileSystem
  > {
    const serverConfig = yield* ServerConfig;
    const registry = yield* readRegistry(serverConfig.stateDir);
    if (registry.dismissedFingerprints.includes(input.fingerprint)) {
      return registry;
    }
    const next = {
      ...registry,
      dismissedFingerprints: [...registry.dismissedFingerprints, input.fingerprint],
    };
    yield* writeRegistry(serverConfig.stateDir, next);
    return next;
  },
);

export const defaultAntigravityGeminiHomePath = (): string => resolveAntigravityGeminiHomePath();
