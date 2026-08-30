/**
 * GitHubAvatarResolver - the last step of project icon discovery: the avatar
 * of a github.com repository owner, for projects no local icon covers.
 * One fetch per owner per repository ever; every failure resolves to null.
 */
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const FETCH_TIMEOUT_MS = 5_000;
const MAX_AVATAR_BYTES = 1024 * 1024;
/** A repository with no avatar is remembered this long before one retry. */
const NEGATIVE_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

  const downloadAvatar = Effect.fn("GitHubAvatarResolver.downloadAvatar")(function* (
    owner: string,
  ) {
    // github.com/<owner>.png is the avatar the repository page itself displays;
    // it is not the rate-limited API. A 404 means private or nonexistent; any
    // other non-2xx is transient and must retry on a later request.
    const response = yield* httpClient.execute(
      HttpClientRequest.get(`https://github.com/${encodeURIComponent(owner)}.png`),
    );
    if (response.status === 404) return { _tag: "negative" } as const;
    if (response.status < 200 || response.status >= 300) return { _tag: "retry" } as const;
    const declaredBytes = Number(response.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_AVATAR_BYTES) {
      return { _tag: "negative" } as const;
    }
    const bytes = new Uint8Array(yield* response.arrayBuffer);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
      return { _tag: "negative" } as const;
    }
    return { _tag: "avatar", bytes } as const;
  });

  // The miss file carries the marker epoch, so the negative TTL survives
  // restarts and is immune to system-clock jumps between write and read.
  const markMissing = Effect.fn("GitHubAvatarResolver.markMissing")(function* (
    cacheKey: string,
    markedAtMs: number,
  ) {
    yield* fileSystem
      .makeDirectory(cacheDir, { recursive: true })
      .pipe(Effect.catchCause(() => Effect.void));
    yield* fileSystem
      .writeFileString(path.join(cacheDir, `${cacheKey}.miss`), String(markedAtMs))
      .pipe(Effect.catchCause(() => Effect.void));
  });

  const fetchAndCache = Effect.fn("GitHubAvatarResolver.fetchAndCache")(function* (
    cacheKey: string,
    owner: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* fileSystem
      .makeDirectory(cacheDir, { recursive: true })
      .pipe(Effect.catchCause(() => Effect.void));
    // Transport failures, timeouts and transient responses return null without
    // a marker, so one blip never hides an icon for the negative TTL.
    const outcome = yield* downloadAvatar(owner).pipe(
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed({ _tag: "retry" } as const)),
    );
    if (outcome._tag !== "avatar") {
      if (outcome._tag === "negative") {
        yield* markMissing(cacheKey, now);
      }
      return null;
    }
    const targetPath = path.join(cacheDir, `${cacheKey}.png`);
    const temporaryPath = `${targetPath}.tmp`;
    const written = yield* fileSystem.writeFile(temporaryPath, outcome.bytes).pipe(Effect.option);
    const renamed =
      Option.isSome(written) &&
      Option.isSome(yield* fileSystem.rename(temporaryPath, targetPath).pipe(Effect.option));
    if (!renamed) {
      yield* markMissing(cacheKey, now);
      return null;
    }
    return targetPath;
  });

  const cachedAvatar = Effect.fn("GitHubAvatarResolver.cachedAvatar")(function* (cacheKey: string) {
    const info = yield* fileSystem.stat(path.join(cacheDir, `${cacheKey}.png`)).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File") {
      return { _tag: "hit", path: path.join(cacheDir, `${cacheKey}.png`) } as const;
    }
    const miss = yield* fileSystem
      .readFileString(path.join(cacheDir, `${cacheKey}.miss`))
      .pipe(Effect.option);
    if (Option.isSome(miss)) {
      const markedAtMs = Number(miss.value);
      const now = yield* Clock.currentTimeMillis;
      if (Number.isFinite(markedAtMs) && now - markedAtMs < NEGATIVE_RESULT_TTL_MS) {
        return { _tag: "negative" } as const;
      }
    }
    return { _tag: "miss" } as const;
  });

  const resolvePath = Effect.fn("GitHubAvatarResolver.resolvePath")(function* (cwd: string) {
    const identity = yield* repositoryIdentityResolver.resolve(cwd);
    const nameWithOwner =
      identity === null
        ? null
        : parseGitHubRepositoryNameWithOwnerFromRemoteUrl(identity.locator.remoteUrl);
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
      return yield* fetchAndCache(cacheKey, owner);
    });
    return yield* semaphore.withPermits(1)(decided);
  });

  return GitHubAvatarResolver.of({
    resolvePath: (cwd) => resolvePath(cwd).pipe(Effect.catchCause(() => Effect.succeed(null))),
    isManagedPath,
  });
});

export const layer = Layer.effect(GitHubAvatarResolver, make);
