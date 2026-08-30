/**
 * GitHubAvatarResolver - the last step of project icon discovery: the owner
 * avatar of a github.com repository, for projects no local icon covers.
 * One fetch per repository ever; every failure resolves to null.
 */
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const FETCH_TIMEOUT_MS = 5_000;
const MAX_AVATAR_BYTES = 1024 * 1024;
/** A repository with no usable avatar is remembered this long before one retry. */
const NEGATIVE_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AVATAR_EXTENSIONS_BY_CONTENT_TYPE: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const CacheEntry = Schema.Struct({
  ok: Schema.Boolean,
  file: Schema.optionalKey(Schema.String),
  fetchedAtMs: Schema.Number,
});
const CacheEntryJson = Schema.fromJsonString(CacheEntry);
const encodeCacheEntry = Schema.encodeSync(CacheEntryJson);

function decodeCacheEntry(raw: string): Schema.Schema.Type<typeof CacheEntry> | null {
  try {
    return Option.getOrNull(Schema.decodeUnknownOption(CacheEntryJson)(raw));
  } catch {
    return null;
  }
}

const RepositorySchema = Schema.Struct({
  owner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

export class GitHubAvatarResolver extends Context.Service<
  GitHubAvatarResolver,
  {
    /** Absolute path of the cached avatar file, or null when there is none. Never fails. */
    readonly resolvePath: (cwd: string) => Effect.Effect<string | null>;
    /** True for files under this service's cache, so the asset route may serve them as project icons. */
    readonly isManagedPath: (filePath: string) => boolean;
  }
>()("t3/project/GitHubAvatarResolver") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const semaphore = yield* Semaphore.make(1);

  const cacheDir = path.join(config.stateDir, "github-avatars");

  const isManagedPath = (filePath: string): boolean => {
    const relative = path.relative(path.resolve(cacheDir), path.resolve(filePath));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  const writeCacheEntry = Effect.fn("GitHubAvatarResolver.writeCacheEntry")(function* (
    cacheKey: string,
    entry: Schema.Schema.Type<typeof CacheEntry>,
  ) {
    yield* fileSystem
      .writeFileString(path.join(cacheDir, `${cacheKey}.json`), encodeCacheEntry(entry))
      .pipe(Effect.catchCause(() => Effect.void));
  });

  type AvatarFetch =
    | { readonly _tag: "avatar"; readonly bytes: Uint8Array; readonly extension: string }
    | { readonly _tag: "negative" }
    | { readonly _tag: "retry" };

  const downloadAvatar = Effect.fn("GitHubAvatarResolver.downloadAvatar")(function* (
    owner: string,
    name: string,
  ) {
    // 404 means private or nonexistent; any other non-2xx (rate limits, 5xx) is
    // transient and must retry on a later request rather than be remembered.
    const repositoryResponse = yield* httpClient.execute(
      HttpClientRequest.get(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      ).pipe(HttpClientRequest.acceptJson),
    );
    if (repositoryResponse.status === 404) return { _tag: "negative" } as const;
    if (repositoryResponse.status < 200 || repositoryResponse.status >= 300) {
      return { _tag: "retry" } as const;
    }
    const decoded = yield* Schema.decodeUnknown(RepositorySchema)(yield* repositoryResponse.json).pipe(
      Effect.option,
    );
    if (Option.isNone(decoded)) return { _tag: "retry" } as const;
    const avatarUrl = decoded.value.owner?.avatar_url;
    // A url from a response is data, not instruction: only the GitHub avatar CDN may be fetched.
    if (!avatarUrl || new URL(avatarUrl).host !== "avatars.githubusercontent.com") {
      return { _tag: "negative" } as const;
    }

    const avatarResponse = yield* httpClient.execute(HttpClientRequest.get(avatarUrl));
    if (avatarResponse.status < 200 || avatarResponse.status >= 300) {
      return { _tag: "negative" } as const;
    }
    const declaredBytes = Number(avatarResponse.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_AVATAR_BYTES) {
      return { _tag: "negative" } as const;
    }
    const bytes = new Uint8Array(yield* avatarResponse.arrayBuffer);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
      return { _tag: "negative" } as const;
    }
    const contentType = (avatarResponse.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    return {
      _tag: "avatar",
      bytes,
      extension: AVATAR_EXTENSIONS_BY_CONTENT_TYPE[contentType] ?? ".png",
    } as const;
  });

  const fetchAndCache = Effect.fn("GitHubAvatarResolver.fetchAndCache")(function* (
    cacheKey: string,
    owner: string,
    name: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* fileSystem.makeDirectory(cacheDir, { recursive: true }).pipe(
      Effect.catchCause(() => Effect.void),
    );
    // Transport failures, timeouts and transient API states return null without
    // a marker, so one blip never hides an icon for the negative TTL.
    const outcome = yield* downloadAvatar(owner, name).pipe(
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.either,
    );
    if (Either.isLeft(outcome)) return null;
    if (outcome.right._tag === "retry") return null;
    if (outcome.right._tag === "negative") {
      yield* writeCacheEntry(cacheKey, { ok: false, fetchedAtMs: now });
      return null;
    }
    const fileName = `${cacheKey}${outcome.right.extension}`;
    const written = yield* fileSystem
      .writeFile(path.join(cacheDir, fileName), outcome.right.bytes)
      .pipe(Effect.option);
    if (Option.isNone(written)) {
      yield* writeCacheEntry(cacheKey, { ok: false, fetchedAtMs: now });
      return null;
    }
    // The sidecar is the commit marker: a cache hit requires it, so a partially
    // written image is never served.
    yield* writeCacheEntry(cacheKey, { ok: true, file: fileName, fetchedAtMs: now });
    return path.join(cacheDir, fileName);
  });

  type CachedAvatar =
    | { readonly _tag: "hit"; readonly path: string }
    | { readonly _tag: "negative" }
    | { readonly _tag: "miss" };

  const cachedAvatar = Effect.fn("GitHubAvatarResolver.cachedAvatar")(function* (cacheKey: string) {
    const raw = yield* fileSystem.readFileString(path.join(cacheDir, `${cacheKey}.json`)).pipe(
      Effect.option,
    );
    const entry = Option.isNone(raw) ? null : decodeCacheEntry(raw.value);
    // A cache hit must name a file of this cache; anything else is a miss.
    if (entry === null || (entry.ok && entry.file !== undefined && path.basename(entry.file) !== entry.file)) {
      return { _tag: "miss" } as const;
    }
    if (entry.ok && entry.file !== undefined) {
      const cachedPath = path.join(cacheDir, entry.file);
      const info = yield* fileSystem.stat(cachedPath).pipe(Effect.option);
      return Option.isSome(info) && info.value.type === "File"
        ? ({ _tag: "hit", path: cachedPath } as const)
        : ({ _tag: "miss" } as const);
    }
    const now = yield* Clock.currentTimeMillis;
    return now - entry.fetchedAtMs < NEGATIVE_RESULT_TTL_MS
      ? ({ _tag: "negative" } as const)
      : ({ _tag: "miss" } as const);
  });

  const resolvePath = Effect.fn("GitHubAvatarResolver.resolvePath")(function* (cwd: string) {
    const identity = yield* repositoryIdentityResolver.resolve(cwd);
    const nameWithOwner =
      identity === null ? null : parseGitHubRepositoryNameWithOwnerFromRemoteUrl(identity.locator.remoteUrl);
    if (nameWithOwner === null) return null;
    const [owner, name] = nameWithOwner.split("/");
    if (!owner || !name) return null;

    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(nameWithOwner));
    const cacheKey = Encoding.encodeHex(digest);

    // Hits and fresh negatives answer without the permit, so a reconnect burst
    // of already-cached projects never queues behind a slow first fetch (#7536).
    const fast = yield* cachedAvatar(cacheKey);
    if (fast._tag !== "miss") return fast._tag === "hit" ? fast.path : null;
    const decided = Effect.gen(function* () {
      const rechecked = yield* cachedAvatar(cacheKey);
      if (rechecked._tag !== "miss") return rechecked._tag === "hit" ? rechecked.path : null;
      return yield* fetchAndCache(cacheKey, owner, name);
    });
    return yield* semaphore.withPermits(1)(decided);
  });

  return GitHubAvatarResolver.of({
    resolvePath: (cwd) => resolvePath(cwd).pipe(Effect.catchCause(() => Effect.succeed(null))),
    isManagedPath,
  });
});

export const layer = Layer.effect(GitHubAvatarResolver, make);
