import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { UserFacingError } from "../UserFacingError.ts";
import { writeFileAtomic } from "../Util/AtomicFile.ts";
import { profileCommandHint } from "../Util/interactive.ts";
import { AuthError, type AuthProvider } from "./AuthProvider.ts";
import { withLock } from "./Lock.ts";
import {
  configFilePath,
  credentialsDirPath,
  profileCredentialsDirPath,
  profileDirPath,
  profileProviderFilePath,
  profilesDirPath,
  rootDir,
} from "./Paths.ts";

export {
  configFilePath,
  credentialsDirPath,
  profileCredentialsDirPath,
  profileDirPath,
  profileProviderFilePath,
  profilesDirPath,
  rootDir,
} from "./Paths.ts";

/** Config key selecting a directory under `~/.alchemy/profiles`. */
export const ALCHEMY_PROFILE = Config.String("ALCHEMY_PROFILE");

/** Version of the synthesized in-memory manifest returned by readManifest. */
export const PROFILE_MANIFEST_VERSION = 3;

/** Stable format identifier for an individual provider profile document. */
export const PROFILE_FORMAT = "alchemy.profile/v1" as const;

export const DEFAULT_PROFILE_NAME = "default";
export const DEFAULT_PROFILE_ID = "default";

/**
 * The minimum contract shared by provider-owned values. Providers refine this
 * with their own Effect Schema codec. The method is deliberately an open
 * string: adding an auth method never changes Alchemy's storage schema.
 */
export const ProviderConfigSchema = Schema.Record(
  Schema.String,
  Schema.Unknown,
);

export interface ProviderConfig {
  readonly method?: string;
  readonly [key: string]: unknown;
}

/** User-facing, non-secret annotations. Provider schemas may refine it. */
export const ProfileMetadataSchema = Schema.Record(
  Schema.String,
  Schema.Unknown,
);
export type ProfileMetadata = typeof ProfileMetadataSchema.Type;

/**
 * Base on-disk schema. Only this envelope is owned by Alchemy core; the
 * selected AuthProvider decodes `metadata` and `values` with its own schemas.
 */
export const ProviderProfileFileSchema = Schema.StructWithRest(
  Schema.Struct({
    format: Schema.Literal(PROFILE_FORMAT),
    provider: Schema.String,
    metadata: ProfileMetadataSchema,
    values: ProviderConfigSchema,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type ProviderProfileFile = typeof ProviderProfileFileSchema.Type;

/** Compose the base envelope with a custom provider's typed schemas. */
export const makeProviderProfileSchema = <Metadata, Values>(
  provider: string,
  metadata: Schema.Codec<Metadata>,
  values: Schema.Codec<Values>,
) =>
  Schema.Struct({
    format: Schema.Literal(PROFILE_FORMAT),
    provider: Schema.Literal(provider),
    metadata,
    values,
  });

/**
 * Aggregate view used by the profile UI. It is synthesized from provider
 * files and is never persisted as a central manifest.
 */
export interface Profile {
  readonly id: string;
  readonly providers: Record<string, ProviderConfig>;
}

export interface ProfileManifest {
  readonly version: typeof PROFILE_MANIFEST_VERSION;
  readonly profiles: Record<string, Profile>;
}

export interface ProfileSelection {
  readonly name: string;
  readonly source: "configuration" | "default";
}

/** Only the released v0 centralized layout is migrated. */
const V0ManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    version: Schema.Literal(0),
    profiles: Schema.Record(Schema.String, Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const LEGACY_CREDENTIAL_KEYS: Record<string, string | Record<string, string>> =
  {
    AWS: "aws-stored",
    Axiom: "axiom-stored",
    Cloudflare: "cloudflare-stored",
    Fly: "fly-stored",
    GitHub: "github-stored",
    Hetzner: "hetzner-stored",
    Neon: "neon-stored",
    Planetscale: {
      stored: "planetscale-stored",
      oauth: "planetscale-oauth",
    },
    Prisma: "prisma-stored",
    Railway: {
      stored: "railway-stored",
      oauth: "railway-oauth",
    },
  };

export class ProfileError extends Schema.TaggedError<ProfileError>()(
  "ProfileError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  readonly [UserFacingError] = true;
}

export class MissingProviderConfig extends Schema.TaggedError<MissingProviderConfig>()(
  "MissingProviderConfig",
  {
    provider: Schema.String,
    profileName: Schema.String,
    message: Schema.String,
  },
) {}

export const SuppressMissingProviderConfig = Context.Reference<boolean>(
  "Auth/SuppressMissingProviderConfig",
  { defaultValue: () => false },
);

const emptyManifest = (): ProfileManifest => ({
  version: PROFILE_MANIFEST_VERSION,
  profiles: {
    [DEFAULT_PROFILE_NAME]: { id: DEFAULT_PROFILE_ID, providers: {} },
  },
});

export const createProfileHint = (name?: string) =>
  Effect.map(
    profileCommandHint(`alchemy profile create ${name ?? "<name>"}`),
    (command) => `Run \`${command}\`.`,
  );

const profileNotFound = Effect.fn(function* (name: string) {
  return new ProfileError({
    message: `Profile '${name}' does not exist. ${yield* createProfileHint(name)}`,
  });
});

export const cannotDeleteDefaultProfile = () =>
  new ProfileError({
    message: `Cannot delete the built-in '${DEFAULT_PROFILE_NAME}' profile.`,
  });

export const cannotRenameDefaultProfile = () =>
  new ProfileError({
    message: `Cannot rename the built-in '${DEFAULT_PROFILE_NAME}' profile.`,
  });

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const validateProfileName = (
  name: string,
): Effect.Effect<string, ProfileError> =>
  PROFILE_NAME_PATTERN.test(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new ProfileError({
          message:
            `Invalid profile name '${name}'. Profile names must start with an ASCII letter or number, ` +
            "contain only letters, numbers, '.', '_' or '-', and be at most 64 characters.",
        }),
      );

const validateProviderName = (
  name: string,
): Effect.Effect<string, ProfileError> =>
  PROFILE_NAME_PATTERN.test(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new ProfileError({
          message: `Invalid provider id '${name}'. Provider ids must be safe as filenames.`,
        }),
      );

export interface ProfileStoreService {
  readonly readManifest: Effect.Effect<
    ProfileManifest,
    ProfileError | PlatformError
  >;
  readonly getProfile: (
    name: string,
  ) => Effect.Effect<Profile | undefined, ProfileError | PlatformError>;
  readonly ensureProfile: (
    name: string,
  ) => Effect.Effect<Profile, ProfileError | PlatformError>;
  readonly createProfile: (
    name: string,
  ) => Effect.Effect<void, ProfileError | PlatformError>;
  readonly renameProfile: (
    name: string,
    newName: string,
  ) => Effect.Effect<void, ProfileError | PlatformError>;
  readonly current: Effect.Effect<
    ProfileSelection,
    ProfileError | PlatformError
  >;
  readonly setProviderConfig: (
    profile: string,
    provider: string,
    values: ProviderConfig,
  ) => Effect.Effect<void, ProfileError | PlatformError>;
  readonly deleteProviderConfig: (
    profile: string,
    provider: string,
  ) => Effect.Effect<boolean, ProfileError | PlatformError>;
  readonly deleteProfile: (
    name: string,
  ) => Effect.Effect<boolean, ProfileError | PlatformError>;
  readonly loadProviderConfig: <Config extends { method: string }>(
    auth: AuthProvider<Config>,
    profileName: string,
  ) => Effect.Effect<
    Config,
    AuthError | MissingProviderConfig | ProfileError | PlatformError
  >;
}

export class ProfileStore extends Context.Service<
  ProfileStore,
  ProfileStoreService
>()("Alchemy::ProfileStore") {}

export const ProfileStoreLive = Layer.effect(
  ProfileStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    yield* fs.makeDirectory(profileDirPath(DEFAULT_PROFILE_NAME), {
      recursive: true,
    });
    yield* fs.chmod(profileDirPath(DEFAULT_PROFILE_NAME), 0o700);

    const provideLockServices = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );

    const decodeJson = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown)),
        ),
        Effect.mapError(
          (cause) =>
            new ProfileError({
              message: `Could not parse '${file}'.`,
              cause,
            }),
        ),
      );

    const backupInvalidProfileFile = (file: string, reason: unknown) =>
      provideLockServices(
        withLock(
          "profiles-invalid",
          Effect.gen(function* () {
            if (!(yield* fs.exists(file))) return undefined;
            const stamp = DateTime.formatIso(yield* DateTime.now)
              .replaceAll(":", "-")
              .replaceAll(".", "-");
            const backup = `${file}.invalid-${stamp}.bak`;
            yield* fs.rename(file, backup);
            yield* Effect.logWarning(
              `Invalid profile file '${file}' was backed up to '${backup}' and skipped.`,
              reason,
            );
            return backup;
          }),
        ),
      );

    const writeProviderFile = (
      profile: string,
      provider: string,
      values: ProviderConfig,
      previous?: ProviderProfileFile,
    ) =>
      Effect.gen(function* () {
        yield* validateProfileName(profile);
        yield* validateProviderName(provider);
        const dir = profileDirPath(profile);
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.chmod(dir, 0o700);
        const document: ProviderProfileFile = {
          format: PROFILE_FORMAT,
          provider,
          metadata: previous?.metadata ?? {},
          values,
        };
        yield* writeFileAtomic(
          fs,
          profileProviderFilePath(profile, provider),
          JSON.stringify(document, null, 2),
          0o600,
        );
      });

    const readLegacyProviderValues = (
      profile: string,
      provider: string,
      values: ProviderConfig,
    ) =>
      Effect.gen(function* () {
        // Cloudflare's released OAuth grant is obsolete, but its stored API
        // token and global API key formats still map exactly to the new
        // provider-owned values schema.
        if (provider === "Cloudflare" && values.method !== "stored") {
          return { method: "oauth" };
        }
        const configuredKey = LEGACY_CREDENTIAL_KEYS[provider];
        const key =
          typeof configuredKey === "string"
            ? configuredKey
            : values.method === undefined
              ? undefined
              : configuredKey?.[values.method];
        if (key === undefined) return values;

        const candidates = [key];
        // The earliest GitHub sidecar used this shorter filename.
        if (provider === "GitHub") candidates.push("gh-stored");
        // The earliest Cloudflare sidecar used this shorter filename.
        if (provider === "Cloudflare") candidates.push("cf-stored");
        let credentialFile: string | undefined;
        for (const candidate of candidates) {
          const file = pathService.join(
            profileCredentialsDirPath(profile),
            `${candidate}.json`,
          );
          if (yield* fs.exists(file)) {
            credentialFile = file;
            break;
          }
        }
        if (credentialFile === undefined) {
          return provider === "Cloudflare" ? {} : values;
        }

        const decoded = yield* Effect.result(
          decodeJson(credentialFile).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ProviderConfigSchema)),
          ),
        );
        if (Result.isFailure(decoded)) {
          yield* Effect.logWarning(
            `Could not decode legacy credentials from '${credentialFile}'; migrating the manifest values and preserving the sidecar in the v0 backup.`,
            decoded.failure,
          );
          return provider === "Cloudflare" ? {} : values;
        }
        const credential = decoded.success;
        const { type: _type, ...inline } = credential;
        const normalizedInline =
          provider === "Axiom" && inline.apiToken !== undefined
            ? (({ apiToken, ...rest }) => ({ ...rest, token: apiToken }))(
                inline,
              )
            : inline;
        const { storageKey: _storageKey, ...manifestValues } = values;
        const migrated: ProviderConfig = {
          ...manifestValues,
          ...normalizedInline,
        };
        if (provider !== "Cloudflare") return migrated;
        return migrated.credentialType === "apiKey" &&
          typeof migrated.apiKey === "string" &&
          typeof migrated.email === "string" &&
          typeof migrated.accountId === "string"
          ? migrated
          : migrated.credentialType === "apiToken" &&
              typeof migrated.apiToken === "string" &&
              typeof migrated.accountId === "string"
            ? migrated
            : {};
      });

    /** Expand the released v0 store and preserve every original file. */
    const migrateCentralManifest = provideLockServices(
      withLock(
        "profiles-migrate",
        Effect.gen(function* () {
          const legacy = configFilePath();
          if (!(yield* fs.exists(legacy))) return;
          const jsonResult = yield* Effect.result(decodeJson(legacy));
          if (Result.isFailure(jsonResult)) {
            yield* backupInvalidProfileFile(legacy, jsonResult.failure);
            return;
          }
          const header = Schema.decodeUnknownOption(
            Schema.Struct({ version: Schema.Number }),
          )(jsonResult.success);
          // The short-lived centralized versions were never released and do
          // not need a compatibility path. Leave them untouched.
          if (Option.isSome(header) && header.value.version !== 0) return;
          const storedResult = yield* Effect.result(
            Schema.decodeUnknownEffect(V0ManifestSchema)(jsonResult.success),
          );
          if (Result.isFailure(storedResult)) {
            yield* backupInvalidProfileFile(legacy, storedResult.failure);
            return;
          }
          const stored = storedResult.success;
          for (const [name, entry] of Object.entries(stored.profiles)) {
            const validName = yield* Effect.result(validateProfileName(name));
            if (Result.isFailure(validName)) {
              yield* Effect.logWarning(
                `Skipping invalid v0 profile name '${name}'. It remains available in the v0 backup.`,
              );
              continue;
            }
            const providersResult = yield* Effect.result(
              Schema.decodeUnknownEffect(
                Schema.Record(Schema.String, Schema.Unknown),
              )(entry),
            );
            if (Result.isFailure(providersResult)) {
              yield* Effect.logWarning(
                `Skipping invalid v0 profile '${name}'. It remains available in the v0 backup.`,
                providersResult.failure,
              );
              continue;
            }
            yield* fs.makeDirectory(profileDirPath(name), { recursive: true });
            yield* fs.chmod(profileDirPath(name), 0o700);
            for (const [provider, rawValues] of Object.entries(
              providersResult.success,
            )) {
              const validProvider = yield* Effect.result(
                validateProviderName(provider),
              );
              if (Result.isFailure(validProvider)) {
                yield* Effect.logWarning(
                  `Skipping invalid v0 provider name '${provider}' in profile '${name}'. It remains available in the v0 backup.`,
                );
                continue;
              }
              const valuesResult = yield* Effect.result(
                Schema.decodeUnknownEffect(ProviderConfigSchema)(rawValues),
              );
              if (Result.isFailure(valuesResult)) {
                if (provider === "Cloudflare") {
                  const target = profileProviderFilePath(name, provider);
                  if (!(yield* fs.exists(target))) {
                    yield* writeProviderFile(name, provider, {});
                  }
                  continue;
                }
                yield* Effect.logWarning(
                  `Skipping invalid v0 provider '${provider}' in profile '${name}'. It remains available in the v0 backup.`,
                  valuesResult.failure,
                );
                continue;
              }
              const values = valuesResult.success;
              if (values.method === "env") continue;
              // Known legacy sidecars become inline provider values.
              const migratedValues = yield* readLegacyProviderValues(
                name,
                provider,
                values,
              );
              const target = profileProviderFilePath(name, provider);
              if (!(yield* fs.exists(target))) {
                yield* writeProviderFile(name, provider, migratedValues);
              }
            }
          }
          const stamp = DateTime.formatIso(yield* DateTime.now)
            .replaceAll(":", "-")
            .replaceAll(".", "-");
          const backup = pathService.join(rootDir(), `.profiles-v0-${stamp}`);
          yield* fs.makeDirectory(backup, { recursive: true });
          yield* fs.chmod(backup, 0o700);
          yield* fs.rename(legacy, pathService.join(backup, "profiles.json"));
          const credentials = credentialsDirPath();
          if (yield* fs.exists(credentials)) {
            yield* fs.rename(
              credentials,
              pathService.join(backup, "credentials"),
            );
          }
        }),
      ),
    );

    const readProviderFile = (profile: string, file: string) =>
      Effect.gen(function* () {
        const fullPath = pathService.join(profileDirPath(profile), file);
        const json = yield* decodeJson(fullPath);
        const document = yield* Schema.decodeUnknownEffect(
          ProviderProfileFileSchema,
        )(json).pipe(
          Effect.mapError(
            (cause) =>
              new ProfileError({
                message: `Invalid provider profile at '${fullPath}'.`,
                cause,
              }),
          ),
        );
        const filenameProvider = file.slice(0, -".json".length);
        if (document.provider.toLowerCase() !== filenameProvider) {
          return yield* Effect.fail(
            new ProfileError({
              message: `Provider '${document.provider}' in '${fullPath}' does not match lowercase filename '${filenameProvider}'.`,
            }),
          );
        }
        return document;
      });

    const readManifest = Effect.gen(function* () {
      yield* migrateCentralManifest;
      const manifest = emptyManifest();
      const names = yield* fs
        .readDirectory(profilesDirPath())
        .pipe(
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed<string[]>([]),
          ),
        );
      for (const name of names) {
        if (!PROFILE_NAME_PATTERN.test(name)) continue;
        const info = yield* fs.stat(profileDirPath(name));
        if (info.type !== "Directory") continue;
        const providers: Record<string, ProviderConfig> = {};
        const files = yield* fs.readDirectory(profileDirPath(name));
        for (const file of files.sort()) {
          if (!file.endsWith(".json")) continue;
          const read = yield* Effect.result(readProviderFile(name, file));
          if (Result.isFailure(read)) {
            yield* backupInvalidProfileFile(
              pathService.join(profileDirPath(name), file),
              read.failure,
            );
            continue;
          }
          providers[read.success.provider] = read.success.values;
        }
        manifest.profiles[name] = { id: name, providers };
      }
      return manifest;
    });

    const getProfile = (name: string) =>
      validateProfileName(name).pipe(
        Effect.flatMap(() => readManifest),
        Effect.map((manifest) => manifest.profiles[name]),
      );

    const ensureProfile = (name: string) =>
      getProfile(name).pipe(
        Effect.flatMap((profile) =>
          profile === undefined
            ? Effect.flatMap(profileNotFound(name), Effect.fail)
            : Effect.succeed(profile),
        ),
      );

    const createProfile = (name: string) =>
      validateProfileName(name).pipe(
        Effect.flatMap(() =>
          provideLockServices(
            withLock(
              "profiles",
              Effect.gen(function* () {
                const existing = (yield* readManifest).profiles[name];
                if (existing !== undefined) {
                  return yield* Effect.fail(
                    new ProfileError({
                      message: `Profile '${name}' already exists.`,
                    }),
                  );
                }
                yield* fs.makeDirectory(profileDirPath(name), {
                  recursive: true,
                });
                yield* fs.chmod(profileDirPath(name), 0o700);
              }),
            ),
          ),
        ),
      );

    const renameProfile = (name: string, newName: string) =>
      Effect.gen(function* () {
        if (name === DEFAULT_PROFILE_NAME) {
          return yield* Effect.fail(cannotRenameDefaultProfile());
        }
        yield* validateProfileName(name);
        yield* validateProfileName(newName);
        yield* provideLockServices(
          withLock(
            "profiles",
            Effect.gen(function* () {
              const manifest = yield* readManifest;
              if (manifest.profiles[name] === undefined) {
                return yield* Effect.fail(
                  new ProfileError({
                    message: `Profile '${name}' does not exist.`,
                  }),
                );
              }
              if (manifest.profiles[newName] !== undefined) {
                return yield* Effect.fail(
                  new ProfileError({
                    message: `Profile '${newName}' already exists.`,
                  }),
                );
              }
              yield* fs.rename(profileDirPath(name), profileDirPath(newName));
              const oldCredentials = profileCredentialsDirPath(name);
              if (yield* fs.exists(oldCredentials)) {
                yield* fs.rename(
                  oldCredentials,
                  profileCredentialsDirPath(newName),
                );
              }
            }),
          ),
        );
      });

    const current: Effect.Effect<
      ProfileSelection,
      ProfileError | PlatformError
    > = Effect.gen(function* () {
      const configured = yield* Config.option(ALCHEMY_PROFILE).pipe(
        Effect.mapError(
          (cause) =>
            new ProfileError({
              message: "Could not resolve ALCHEMY_PROFILE.",
              cause,
            }),
        ),
      );
      if (Option.isSome(configured)) {
        return {
          name: yield* validateProfileName(configured.value),
          source: "configuration" as const,
        };
      }
      return { name: DEFAULT_PROFILE_NAME, source: "default" as const };
    });

    const setProviderConfig = (
      profile: string,
      provider: string,
      values: ProviderConfig,
    ) =>
      Effect.gen(function* () {
        yield* validateProfileName(profile);
        yield* validateProviderName(provider);
        yield* provideLockServices(
          withLock(
            "profiles",
            Effect.gen(function* () {
              if ((yield* readManifest).profiles[profile] === undefined) {
                return yield* Effect.flatMap(
                  profileNotFound(profile),
                  Effect.fail,
                );
              }
              const file = profileProviderFilePath(profile, provider);
              let previous: ProviderProfileFile | undefined;
              if (yield* fs.exists(file)) {
                const read = yield* Effect.result(
                  readProviderFile(profile, `${provider.toLowerCase()}.json`),
                );
                if (Result.isFailure(read)) {
                  yield* backupInvalidProfileFile(file, read.failure);
                } else {
                  previous = read.success;
                }
              }
              yield* writeProviderFile(profile, provider, values, previous);
            }),
          ),
        );
      });

    const deleteProviderConfig = (profile: string, provider: string) =>
      Effect.gen(function* () {
        yield* validateProfileName(profile);
        yield* validateProviderName(provider);
        return yield* provideLockServices(
          withLock(
            "profiles",
            Effect.gen(function* () {
              const file = profileProviderFilePath(profile, provider);
              if (!(yield* fs.exists(file))) return false;
              yield* fs.remove(file);
              return true;
            }),
          ),
        );
      });

    const deleteProfile = (
      name: string,
    ): Effect.Effect<boolean, ProfileError | PlatformError> =>
      Effect.gen(function* () {
        yield* validateProfileName(name);
        if (name === DEFAULT_PROFILE_NAME) {
          return yield* Effect.fail(cannotDeleteDefaultProfile());
        }
        return yield* provideLockServices(
          withLock(
            "profiles",
            Effect.gen(function* () {
              const dir = profileDirPath(name);
              if (!(yield* fs.exists(dir))) return false;
              yield* fs.remove(dir, { recursive: true });
              const credentials = profileCredentialsDirPath(name);
              if (yield* fs.exists(credentials)) {
                yield* fs.remove(credentials, { recursive: true });
              }
              return true;
            }),
          ),
        );
      });

    const loadProviderConfig = <Config extends { method: string }>(
      auth: AuthProvider<Config>,
      profileName: string,
    ) =>
      Effect.gen(function* () {
        const existing = yield* ensureProfile(profileName);
        const stored = existing.providers[auth.name];
        if (stored !== undefined) {
          return yield* auth.decodeConfig(profileName, stored);
        }
        if (yield* SuppressMissingProviderConfig) {
          return yield* Effect.fail(
            new MissingProviderConfig({
              provider: auth.name,
              profileName,
              message: `Provider '${auth.name}' is not configured in profile '${profileName}'.`,
            }),
          );
        }
        const command = yield* profileCommandHint(
          `alchemy profile edit --profile ${profileName} --add ${auth.name}`,
        );
        return yield* Effect.fail(
          new AuthError({
            message: `Provider '${auth.name}' is not configured in profile '${profileName}'. Run \`${command}\`.`,
          }),
        );
      });

    return {
      readManifest,
      getProfile,
      ensureProfile,
      createProfile,
      renameProfile,
      current,
      setProviderConfig,
      deleteProviderConfig,
      deleteProfile,
      loadProviderConfig,
    } satisfies ProfileStoreService;
  }),
);

/** The name of the currently selected profile. */
export const currentProfileName: Effect.Effect<
  string,
  ProfileError | PlatformError,
  ProfileStore
> = ProfileStore.use((store) => store.current).pipe(
  Effect.map((selection) => selection.name),
);
