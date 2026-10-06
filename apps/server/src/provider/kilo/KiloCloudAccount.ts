import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import { Hex } from "effect/encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { KiloCloudError } from "./KiloCloudError.ts";

const isKiloCloudError = Schema.is(KiloCloudError);

const Auth = Schema.Struct({
  kilo: Schema.Union([
    Schema.Struct({ type: Schema.Literal("oauth"), access: Schema.NonEmptyString }),
    Schema.Struct({ type: Schema.Literal("api"), key: Schema.NonEmptyString }),
  ]),
});
const Profile = Schema.Struct({
  user: Schema.Struct({ id: Schema.NonEmptyString }),
  hasPersonalAccount: Schema.Boolean,
});

const decodeAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(Auth));
const decodeProfile = Schema.decodeUnknownEffect(Profile);
const Identity = Schema.Struct({
  accountId: Schema.NonEmptyString,
  tokenHash: Schema.NonEmptyString,
});
const decodeIdentity = Schema.decodeUnknownEffect(Schema.fromJsonString(Identity));
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Identity));

/** Reads only the selected official CLI profile. Login and token refresh remain Kilo's job. */
export const make = Effect.fn("KiloCloudAccount.make")(function* (
  profileDirectory: string,
  origin = "https://app.kilo.ai",
  identityPath?: string,
) {
  if (origin !== "https://app.kilo.ai" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
    return yield* new KiloCloudError({ operation: "authentication", reason: "rejected" });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  let cached: { token: Redacted.Redacted<string>; accountId: string } | undefined;
  const readToken = Effect.gen(function* () {
    const saved = yield* decodeAuth(
      yield* fs
        .readFileString(path.join(profileDirectory, "data", "kilo", "auth.json"))
        .pipe(
          Effect.mapError(
            () => new KiloCloudError({ operation: "credentials", reason: "rejected" }),
          ),
        ),
    ).pipe(
      Effect.mapError(() => new KiloCloudError({ operation: "credentials", reason: "rejected" })),
    );
    const token = saved.kilo.type === "oauth" ? saved.kilo.access : saved.kilo.key;
    return token;
  });
  const tokenHash = (token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(Hex.encode));
  const load = Effect.gen(function* () {
    const token = yield* readToken;
    if (cached && Redacted.value(cached.token) === token) return cached;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/api/profile`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    if (response.status !== 200)
      return yield* new KiloCloudError({
        operation: "authentication",
        reason:
          response.status === 401 || response.status === 403 ? "rejected" : "invalid_response",
      });
    const profile = yield* decodeProfile(yield* response.json);
    if (!profile.hasPersonalAccount)
      return yield* new KiloCloudError({ operation: "personal-account", reason: "unsupported" });
    cached = { accountId: profile.user.id, token: Redacted.make(token) };
    if (identityPath) {
      const identity = encodeIdentity({
        accountId: cached.accountId,
        tokenHash: yield* tokenHash(token),
      });
      yield* fs
        .makeDirectory(path.dirname(identityPath), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(identityPath, identity)), Effect.ignore);
    }
    return cached;
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provide(FetchHttpClient.layer),
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      isKiloCloudError(cause)
        ? cause
        : new KiloCloudError({ operation: "authentication", reason: "invalid_response" }),
    ),
  );
  // This restores only the immutable binding. Requests still verify through load.
  const restore = Effect.gen(function* () {
    if (identityPath) {
      const token = yield* readToken;
      const prior = yield* fs
        .readFileString(identityPath)
        .pipe(Effect.flatMap(decodeIdentity), Effect.option);
      if (prior._tag === "Some" && prior.value.tokenHash === (yield* tokenHash(token)))
        return { accountId: prior.value.accountId, token: Redacted.make(token), verified: false };
    }
    return { ...(yield* load), verified: true };
  }).pipe(
    Effect.mapError((cause) =>
      isKiloCloudError(cause)
        ? cause
        : new KiloCloudError({ operation: "authentication", reason: "invalid_response" }),
    ),
  );
  return { load, restore };
});
