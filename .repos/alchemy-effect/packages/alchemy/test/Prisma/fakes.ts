import { AuthError } from "@/Auth/AuthProvider";
import type { CredentialsStore } from "@/Auth/Credentials";
import type { ProfileStore } from "@/Auth/Profile";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const makeFakeProfileStore = (
  overrides?: Partial<ProfileStore["Service"]>,
): ProfileStore["Service"] => ({
  readManifest: Effect.succeed({ version: 3, profiles: {} }),
  getProfile: () => Effect.succeed(undefined),
  ensureProfile: () => Effect.succeed({ id: "fake", providers: {} }),
  createProfile: () => Effect.void,
  renameProfile: () => Effect.void,
  current: Effect.succeed({ name: "default", source: "configuration" }),
  setProviderConfig: () => Effect.void,
  deleteProviderConfig: () => Effect.succeed(false),
  deleteProfile: () => Effect.succeed(false),
  loadProviderConfig: <Config extends { method: string }>() =>
    Effect.succeed({ method: "stored" } as Config),
  ...overrides,
});

export const makeFakeCredentialsStore = (
  stored?: unknown,
): CredentialsStore["Service"] => ({
  read: <A, E>(
    _profile: string,
    _provider: string,
    schema: Schema.Codec<A, E>,
  ) =>
    stored === undefined
      ? Effect.succeed(undefined)
      : Schema.decodeUnknownEffect(schema)(stored).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Stored credentials do not match the expected shape.",
                cause,
              }),
          ),
        ),
  write: () => Effect.void,
  delete: () => Effect.void,
  deleteProfile: () => Effect.void,
});
