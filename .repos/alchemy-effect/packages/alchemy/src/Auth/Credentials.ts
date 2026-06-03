import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import path from "pathe";
import { rootDir } from "./Profile.ts";

const credentialsDirPath = path.join(rootDir, "credentials");

export const profileCredentialsDirPath = (profile: string) =>
  path.join(credentialsDirPath, profile);

export const credentialsFilePath = (profile: string, provider: string) =>
  path.join(profileCredentialsDirPath(profile), `${provider}.json`);

/**
 * Service exposing per-profile credential file helpers. All methods have
 * `R = never` — the {@link FileSystem.FileSystem} requirement is captured
 * by {@link CredentialsStoreLive} when the layer is built.
 */
export interface CredentialsStoreService {
  readonly read: <T>(
    profile: string,
    provider: string,
  ) => Effect.Effect<T | undefined>;
  readonly write: <T>(
    profile: string,
    provider: string,
    credentials: T,
  ) => Effect.Effect<void, PlatformError>;
  readonly delete: (profile: string, provider: string) => Effect.Effect<void>;
  /**
   * Recursively remove the `~/.alchemy/credentials/{profile}` directory
   * containing all per-provider secrets for `profile`. No-op if it doesn't exist.
   */
  readonly deleteProfile: (profile: string) => Effect.Effect<void>;
}

export class CredentialsStore extends Context.Service<
  CredentialsStore,
  CredentialsStoreService
>()("Alchemy::CredentialsStore") {}

export const CredentialsStoreLive = Layer.effect(
  CredentialsStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const read = <T>(
      profile: string,
      provider: string,
    ): Effect.Effect<T | undefined> =>
      fs.readFileString(credentialsFilePath(profile, provider)).pipe(
        Effect.catch(() => Effect.succeed(undefined as string | undefined)),
        Effect.map((data) => {
          if (data === undefined) return undefined as T | undefined;
          try {
            return JSON.parse(data) as T;
          } catch {
            return undefined as T | undefined;
          }
        }),
      );

    const write = <T>(
      profile: string,
      provider: string,
      credentials: T,
    ): Effect.Effect<void, PlatformError> => {
      const filePath = credentialsFilePath(profile, provider);
      return fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
        Effect.flatMap(() => {
          return fs.writeFileString(
            filePath,
            JSON.stringify(credentials, null, 2),
          );
        }),
      );
    };

    const remove_ = (profile: string, provider: string): Effect.Effect<void> =>
      fs
        .remove(credentialsFilePath(profile, provider))
        .pipe(Effect.catch(() => Effect.void));

    const deleteProfile = (profile: string): Effect.Effect<void> =>
      fs
        .remove(profileCredentialsDirPath(profile), { recursive: true })
        .pipe(Effect.catch(() => Effect.void));

    return {
      read,
      write,
      delete: remove_,
      deleteProfile,
    } satisfies CredentialsStoreService;
  }),
);

export function displayRedacted(
  r: Redacted.Redacted<string>,
  visibleChars = 4,
): string {
  const raw = Redacted.value(r);
  if (raw.length <= visibleChars) return "****";
  return `${raw.slice(0, visibleChars)}****`;
}
