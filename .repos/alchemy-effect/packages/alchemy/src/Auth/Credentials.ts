import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import path from "pathe";
import { writeFileAtomic } from "../Util/AtomicFile.ts";
import { profileCommandHint } from "../Util/interactive.ts";
import { AuthError } from "./AuthProvider.ts";
import { profileCredentialsDirPath } from "./Paths.ts";
import { validateProfileName } from "./Profile.ts";

export const credentialsFilePath = (profile: string, provider: string) =>
  path.join(profileCredentialsDirPath(profile), `${provider}.json`);

/**
 * Service exposing per-profile credential file helpers. All methods have
 * `R = never` — the {@link FileSystem.FileSystem} requirement is captured
 * by {@link CredentialsStoreLive} when the layer is built.
 *
 * Reads and writes go through the provider's declared credential schema, so
 * a hand-edited or corrupted secrets file surfaces as a typed `AuthError`
 * (with a reconfigure hint) instead of propagating malformed data into API
 * calls.
 */
export interface CredentialsStoreService {
  readonly read: <A, E>(
    profile: string,
    provider: string,
    schema: Schema.Codec<A, E>,
  ) => Effect.Effect<A | undefined, AuthError>;
  readonly write: <A, E>(
    profile: string,
    provider: string,
    schema: Schema.Codec<A, E>,
    credentials: A,
  ) => Effect.Effect<void, AuthError>;
  readonly delete: (profile: string, provider: string) => Effect.Effect<void, AuthError>;
  /**
   * Recursively remove the `~/.alchemy/credentials/{profile}` directory
   * containing all per-provider secrets for `profile`. No-op if it doesn't exist.
   */
  readonly deleteProfile: (profile: string) => Effect.Effect<void, AuthError>;
  /**
   * The same store rooted at `dirFor(profile)` instead of
   * `~/.alchemy/credentials/{profile}` — for caches kept beside a profile
   * rather than with its credentials.
   */
  readonly scoped: (dirFor: (profile: string) => string) => CredentialsStoreService;
}

export class CredentialsStore extends Context.Service<CredentialsStore, CredentialsStoreService>()(
  "Alchemy::CredentialsStore",
) {}

export const CredentialsStoreLive = Layer.effect(
  CredentialsStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const make = (dirFor: (profile: string) => string): CredentialsStoreService => {
      const validateCredentialPath = validateCredentialPathIn(dirFor);

      const read = <A, E>(profile: string, provider: string, schema: Schema.Codec<A, E>) =>
        Effect.gen(function* () {
          const filePath = yield* validateCredentialPath(profile, provider);
          const data = yield* fs.readFileString(filePath).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
            Effect.mapError((cause) =>
              AuthError.make({
                message: `Could not read credentials at '${filePath}'.`,
                cause,
              }),
            ),
          );
          if (data === undefined) return undefined;
          const json = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(data).pipe(
            Effect.mapError((cause) =>
              AuthError.make({
                message: `Stored credentials at '${filePath}' contain invalid JSON.`,
                cause,
              }),
            ),
          );
          const command = yield* profileCommandHint(
            `alchemy profile edit --profile ${profile} --reconfigure ${provider}`,
          );
          return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
            Effect.mapError((cause) =>
              AuthError.make({
                message:
                  `Stored credentials at '${filePath}' do not match the expected shape. ` +
                  `Run \`${command}\` to replace them.`,
                cause,
              }),
            ),
          );
        });

      const write = <A, E>(
        profile: string,
        provider: string,
        schema: Schema.Codec<A, E>,
        credentials: A,
      ) =>
        Effect.gen(function* () {
          const filePath = yield* validateCredentialPath(profile, provider);
          const encoded = yield* Schema.encodeEffect(schema)(credentials).pipe(
            Effect.mapError((cause) =>
              AuthError.make({
                message: `Credentials for '${provider}' do not match the declared schema.`,
                cause,
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const directory = path.dirname(filePath);
            yield* fs.makeDirectory(directory, { recursive: true });
            yield* fs.chmod(directory, 0o700);
            yield* writeFileAtomic(fs, filePath, JSON.stringify(encoded, null, 2), 0o600);
          }).pipe(
            Effect.mapError((cause) =>
              AuthError.make({
                message: `Could not write credentials at '${filePath}'.`,
                cause,
              }),
            ),
          );
        });

      const remove_ = (profile: string, provider: string): Effect.Effect<void, AuthError> =>
        validateCredentialPath(profile, provider).pipe(
          Effect.flatMap((filePath) =>
            fs.remove(filePath).pipe(
              Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
              Effect.mapError((cause) =>
                AuthError.make({
                  message: `Could not delete credentials at '${filePath}'.`,
                  cause,
                }),
              ),
            ),
          ),
        );

      const deleteProfile = (profile: string) =>
        Effect.gen(function* () {
          yield* validateProfileName(profile).pipe(
            Effect.mapError((cause) => AuthError.make({ message: cause.message, cause })),
          );
          yield* fs.remove(dirFor(profile), { recursive: true }).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
            Effect.mapError((cause) =>
              AuthError.make({
                message: `Could not delete credentials for profile '${profile}'.`,
                cause,
              }),
            ),
          );
        });

      return {
        read,
        write,
        delete: remove_,
        deleteProfile,
        scoped: make,
      } satisfies CredentialsStoreService;
    };

    return make(profileCredentialsDirPath);
  }),
);

const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const validateCredentialPathIn =
  (dirFor: (profile: string) => string) => (profile: string, provider: string) =>
    Effect.gen(function* () {
      yield* validateProfileName(profile).pipe(
        Effect.mapError((cause) => AuthError.make({ message: cause.message, cause })),
      );
      if (!CREDENTIAL_KEY_PATTERN.test(provider)) {
        return yield* AuthError.make({
          message: `Invalid credential key '${provider}'.`,
        });
      }
      return path.join(dirFor(profile), `${provider}.json`);
    });

export function displayRedacted(r: Redacted.Redacted<string>, visibleChars = 4): string {
  const raw = Redacted.value(r);
  if (raw.length <= visibleChars) return "****";
  return `${raw.slice(0, visibleChars)}****`;
}
