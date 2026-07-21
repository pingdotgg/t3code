import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

const MANAGED_RELAY_TOKEN_CACHE_KEY = "t3code.cloud.relay-access-tokens";
const MANAGED_RELAY_TOKEN_CACHE_VERSION = 1;

const ManagedRelayAccessTokenCacheEntrySchema = Schema.Struct({
  accountId: Schema.String,
  clientId: Schema.Literals(["t3-mobile", "t3-web"]),
  relayUrl: Schema.String,
  thumbprint: Schema.String,
  scopes: Schema.Array(
    Schema.Literals(["environment:connect", "environment:status", "mobile:registration"]),
  ),
  accessToken: Schema.String,
  expiresAtMillis: Schema.Number,
});

const ManagedRelayAccessTokenCacheSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(MANAGED_RELAY_TOKEN_CACHE_VERSION),
    entries: Schema.Array(ManagedRelayAccessTokenCacheEntrySchema),
  }),
);

const decodeManagedRelayAccessTokenCache = Schema.decodeUnknownEffect(
  ManagedRelayAccessTokenCacheSchema,
);
const encodeManagedRelayAccessTokenCache = Schema.encodeEffect(ManagedRelayAccessTokenCacheSchema);

export class ManagedRelayTokenStoreError extends Data.TaggedError("ManagedRelayTokenStoreError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const storeError =
  (message: string) =>
  (cause: unknown): ManagedRelayTokenStoreError =>
    new ManagedRelayTokenStoreError({ message, cause });

function logStoreFailure(operation: string) {
  return (error: ManagedRelayTokenStoreError) =>
    Effect.logWarning(`Managed relay token store ${operation} failed.`).pipe(
      Effect.annotateLogs({
        errorTag: error._tag,
        message: error.message,
      }),
    );
}

const loadManagedRelayAccessTokens = Effect.tryPromise({
  try: () => SecureStore.getItemAsync(MANAGED_RELAY_TOKEN_CACHE_KEY),
  catch: storeError("Could not read persisted relay access tokens."),
}).pipe(
  Effect.flatMap((encoded) =>
    encoded === null
      ? Effect.succeed<ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry>>([])
      : decodeManagedRelayAccessTokenCache(encoded).pipe(
          Effect.map((cache) => cache.entries),
          Effect.mapError(storeError("Persisted relay access tokens are invalid.")),
        ),
  ),
);

const saveManagedRelayAccessTokens = (
  entries: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry>,
) =>
  encodeManagedRelayAccessTokenCache({
    version: MANAGED_RELAY_TOKEN_CACHE_VERSION,
    entries,
  }).pipe(
    Effect.mapError(storeError("Could not encode relay access tokens.")),
    Effect.flatMap((encoded) =>
      Effect.tryPromise({
        try: () => SecureStore.setItemAsync(MANAGED_RELAY_TOKEN_CACHE_KEY, encoded),
        catch: storeError("Could not persist relay access tokens."),
      }),
    ),
  );

const clearManagedRelayAccessTokens = Effect.tryPromise({
  try: () => SecureStore.deleteItemAsync(MANAGED_RELAY_TOKEN_CACHE_KEY),
  catch: storeError("Could not clear persisted relay access tokens."),
});

export const managedRelayAccessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
  load: loadManagedRelayAccessTokens.pipe(
    Effect.tapError(logStoreFailure("load")),
    Effect.orElseSucceed(() => []),
    Effect.withSpan("mobile.managedRelayTokenStore.load"),
  ),
  save: Effect.fn("mobile.managedRelayTokenStore.save")((entries) =>
    saveManagedRelayAccessTokens(entries).pipe(
      Effect.tapError(logStoreFailure("save")),
      Effect.ignore,
    ),
  ),
  clear: clearManagedRelayAccessTokens.pipe(
    Effect.tapError(logStoreFailure("clear")),
    Effect.ignore,
    Effect.withSpan("mobile.managedRelayTokenStore.clear"),
  ),
};
