import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const RemoteCliStoredToken = Schema.Struct({
  accessToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
});
export type RemoteCliStoredToken = typeof RemoteCliStoredToken.Type;

const RemoteCliStoredTokenJson = Schema.fromJsonString(RemoteCliStoredToken);
const decodeStoredToken = Schema.decodeUnknownEffect(RemoteCliStoredTokenJson);
const encodeStoredToken = Schema.encodeEffect(RemoteCliStoredTokenJson);

export class RemoteCliTokenStoreError extends Schema.TaggedErrorClass<RemoteCliTokenStoreError>()(
  "RemoteCliTokenStoreError",
  {
    operation: Schema.Literals(["read", "write", "secure", "decode"]),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the remote CLI access token.`;
  }
}

export class RemoteCliTokenMissingError extends Schema.TaggedErrorClass<RemoteCliTokenMissingError>()(
  "RemoteCliTokenMissingError",
  {},
) {
  override get message(): string {
    return "No remote CLI access token is stored for this host; run `t3 remote auth` first.";
  }
}

export class RemoteCliTokenExpiredError extends Schema.TaggedErrorClass<RemoteCliTokenExpiredError>()(
  "RemoteCliTokenExpiredError",
  {},
) {
  override get message(): string {
    return "The stored remote CLI access token has expired; run `t3 remote auth` again.";
  }
}

export function normalizeRemoteHttpBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Remote host must use HTTP or HTTPS.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("Remote host must not contain credentials.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export const remoteCliTokenPath = (stateDirectory: string, httpBaseUrl: string): string => {
  const originKey = encodeURIComponent(normalizeRemoteHttpBaseUrl(httpBaseUrl));
  return `${stateDirectory}/tokens/${originKey}.json`;
};

const cliTokenPath = (input: {
  readonly stateDirectory: string;
  readonly httpBaseUrl: string;
  readonly tokenStorageKey?: string;
}) =>
  input.tokenStorageKey === undefined
    ? remoteCliTokenPath(input.stateDirectory, input.httpBaseUrl)
    : `${input.stateDirectory}/tokens/${encodeURIComponent(input.tokenStorageKey)}.json`;

export const storeRemoteCliToken = Effect.fn("remoteCli.tokenStore.store")(function* (input: {
  readonly stateDirectory: string;
  readonly httpBaseUrl: string;
  readonly tokenStorageKey?: string;
  readonly token: RemoteCliStoredToken;
}): Effect.fn.Return<
  void,
  RemoteCliTokenStoreError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const tokenPath = cliTokenPath(input);
  const tokenDirectory = path.dirname(tokenPath);
  const encoded = yield* encodeStoredToken(input.token).pipe(
    Effect.mapError(() => new RemoteCliTokenStoreError({ operation: "write" })),
  );
  yield* fs
    .makeDirectory(tokenDirectory, { recursive: true })
    .pipe(Effect.mapError(() => new RemoteCliTokenStoreError({ operation: "write" })));
  yield* fs
    .chmod(input.stateDirectory, 0o700)
    .pipe(Effect.mapError(() => new RemoteCliTokenStoreError({ operation: "secure" })));
  yield* fs
    .chmod(tokenDirectory, 0o700)
    .pipe(Effect.mapError(() => new RemoteCliTokenStoreError({ operation: "secure" })));
  const suffix = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => new RemoteCliTokenStoreError({ operation: "write" })),
  );
  const temporaryPath = `${tokenPath}.${suffix}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(new TextEncoder().encode(`${encoded}\n`));
      yield* file.sync;
    }),
  ).pipe(
    Effect.andThen(fs.chmod(temporaryPath, 0o600)),
    Effect.andThen(fs.rename(temporaryPath, tokenPath)),
    Effect.andThen(fs.chmod(tokenPath, 0o600)),
    Effect.mapError(() => new RemoteCliTokenStoreError({ operation: "write" })),
    Effect.catch((error) =>
      fs
        .remove(temporaryPath, { force: true })
        .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
    ),
  );
});

export const loadRemoteCliToken = Effect.fn("remoteCli.tokenStore.load")(function* (input: {
  readonly stateDirectory: string;
  readonly httpBaseUrl: string;
  readonly tokenStorageKey?: string;
}): Effect.fn.Return<
  RemoteCliStoredToken,
  RemoteCliTokenStoreError | RemoteCliTokenMissingError | RemoteCliTokenExpiredError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const tokenPath = cliTokenPath(input);
  const raw = yield* fs.readFileString(tokenPath).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(new RemoteCliTokenStoreError({ operation: "read" })),
    ),
  );
  if (Option.isNone(raw)) {
    return yield* new RemoteCliTokenMissingError({});
  }
  yield* fs
    .chmod(tokenPath, 0o600)
    .pipe(Effect.mapError(() => new RemoteCliTokenStoreError({ operation: "secure" })));
  const token = yield* decodeStoredToken(raw.value.trim()).pipe(
    Effect.mapError(() => new RemoteCliTokenStoreError({ operation: "decode" })),
  );
  const now = yield* Clock.currentTimeMillis;
  if (token.expiresAtEpochMs <= now) {
    return yield* new RemoteCliTokenExpiredError({});
  }
  return token;
});
