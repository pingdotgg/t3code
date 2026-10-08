/**
 * GitLabProjectAvatarResolver - the last step of project icon discovery: the
 * avatar a GitLab project sets for itself, for projects no local icon covers.
 *
 * The image downloads through `glab`, so private and self-hosted projects work
 * wherever the GitLab integration already does. Answers are kept on disk under
 * the state dir and rechecked daily; a failed download is retried after ten minutes.
 *
 * @module GitLabProjectAvatarResolver
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Hex from "effect/encoding/Hex";

import * as ServerConfig from "../config.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const CACHE_DIRECTORY_NAME = "gitlab-project-avatars";
/** Avatars and "no avatar" answers are both rechecked after this long. */
const CACHE_TTL_MS = Duration.toMillis(Duration.days(1));
/** After `glab` fails (missing, signed out, offline), wait this long before asking again. */
const RETRY_DELAY_MS = Duration.toMillis(Duration.minutes(10));
const DOWNLOAD_TIMEOUT_MS = 10_000;
// GitLab caps avatars at 200 KiB; anything larger is not one.
const MAX_AVATAR_BYTES = 1024 * 1024;
const MISS_EXTENSION = ".miss";
const AVATAR_EXTENSIONS = [".png", ".jpg", ".gif", ".webp", ".ico"] as const;
type AvatarExtension = (typeof AVATAR_EXTENSIONS)[number];

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

// GitLab serves avatars as application/octet-stream, and the asset route
// serves by extension, so the format comes from the file signature. Formats
// GitLab accepts but browsers do not render (BMP, TIFF) fall back to the monogram.
function sniffAvatarExtension(bytes: Uint8Array): AvatarExtension | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ".png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return ".jpg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return ".gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return ".webp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return ".ico";
  return null;
}

export class GitLabProjectAvatarResolver extends Context.Service<
  GitLabProjectAvatarResolver,
  {
    /**
     * Absolute path of the cached avatar for the GitLab project `cwd` belongs
     * to, or `null` when it is not a GitLab checkout or the project has no
     * avatar. Never fails: every failure resolves to `null`.
     */
    readonly resolvePath: (cwd: string) => Effect.Effect<string | null>;
    /** True for files in this service's cache, which the asset route may serve as project icons. */
    readonly isManagedPath: (filePath: string) => boolean;
  }
>()("t3/project/GitLabProjectAvatarResolver") {}

type CacheEntry =
  | { readonly _tag: "avatar"; readonly path: string; readonly fresh: boolean }
  | { readonly _tag: "missing"; readonly fresh: boolean };

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const gitLabCli = yield* GitLabCli.GitLabCli;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  // One download at a time, so a reconnect burst of uncached projects never
  // fans out into a `glab` process per project.
  const downloads = yield* Semaphore.make(1);
  const retryAfterMsByKey = new Map<string, number>();

  const cacheDir = path.join(config.stateDir, CACHE_DIRECTORY_NAME);
  const entryPath = (cacheKey: string, extension: string) =>
    path.join(cacheDir, `${cacheKey}${extension}`);

  const isManagedPath = (filePath: string): boolean => {
    const relative = path.relative(path.resolve(cacheDir), path.resolve(filePath));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  // A crash between writeEntry's rename and its cleanup can leave an expired
  // entry beside a fresh one, so a fresh entry always wins.
  const readEntry = Effect.fn("GitLabProjectAvatarResolver.readEntry")(function* (
    cacheKey: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    let staleEntry: CacheEntry | null = null;
    for (const extension of [...AVATAR_EXTENSIONS, MISS_EXTENSION]) {
      const filePath = entryPath(cacheKey, extension);
      const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const writtenAtMs = Option.match(info.value.mtime, {
        onNone: () => 0,
        onSome: (mtime) => mtime.getTime(),
      });
      const fresh = now - writtenAtMs < CACHE_TTL_MS;
      const entry: CacheEntry =
        extension === MISS_EXTENSION
          ? { _tag: "missing", fresh }
          : { _tag: "avatar", path: filePath, fresh };
      if (fresh) return entry;
      staleEntry ??= entry;
    }
    return staleEntry;
  });

  // Writes one entry and removes the others, so a project never has two answers.
  const writeEntry = Effect.fn("GitLabProjectAvatarResolver.writeEntry")(function* (
    cacheKey: string,
    extension: AvatarExtension | typeof MISS_EXTENSION,
    bytes: Uint8Array,
  ) {
    yield* fileSystem.makeDirectory(cacheDir, { recursive: true });
    const targetPath = entryPath(cacheKey, extension);
    // The rename is atomic, so a reader never sees a partly written image.
    const temporaryPath = `${targetPath}.tmp`;
    yield* fileSystem.writeFile(temporaryPath, bytes);
    yield* fileSystem.rename(temporaryPath, targetPath);
    for (const other of [...AVATAR_EXTENSIONS, MISS_EXTENSION]) {
      if (other === extension) continue;
      yield* fileSystem.remove(entryPath(cacheKey, other), { force: true });
    }
    return targetPath;
  });

  const download = Effect.fn("GitLabProjectAvatarResolver.download")(function* (
    cwd: string,
    cacheKey: string,
    stale: CacheEntry | null,
  ) {
    const staleAvatar = stale?._tag === "avatar" ? stale.path : null;
    const now = yield* Clock.currentTimeMillis;
    if ((retryAfterMsByKey.get(cacheKey) ?? 0) > now) return staleAvatar;

    const bytes = yield* gitLabCli
      .getProjectAvatar({ cwd, maxBytes: MAX_AVATAR_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS })
      .pipe(Effect.option);
    if (Option.isNone(bytes)) {
      // Drop expired deadlines first, so projects that are never revisited do
      // not accumulate here.
      for (const [key, retryAfterMs] of retryAfterMsByKey) {
        if (retryAfterMs <= now) retryAfterMsByKey.delete(key);
      }
      // Keep showing the previous avatar while GitLab is out of reach.
      retryAfterMsByKey.set(cacheKey, now + RETRY_DELAY_MS);
      return staleAvatar;
    }
    retryAfterMsByKey.delete(cacheKey);
    const extension = bytes.value === null ? null : sniffAvatarExtension(bytes.value);
    if (bytes.value === null || extension === null) {
      yield* writeEntry(cacheKey, MISS_EXTENSION, new Uint8Array());
      return null;
    }
    return yield* writeEntry(cacheKey, extension, bytes.value);
  });

  const resolvePath = Effect.fn("GitLabProjectAvatarResolver.resolvePath")(function* (cwd: string) {
    const identity = yield* repositoryIdentityResolver.resolve(cwd);
    if (identity?.provider !== "gitlab") return null;
    const cacheKey = Hex.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(identity.canonicalKey)),
    );

    // Fresh answers skip the permit, so cached projects never queue behind a
    // slow download.
    const cached = yield* readEntry(cacheKey);
    if (cached?.fresh) return cached._tag === "avatar" ? cached.path : null;
    return yield* downloads.withPermits(1)(
      Effect.gen(function* () {
        const rechecked = yield* readEntry(cacheKey);
        if (rechecked?.fresh) return rechecked._tag === "avatar" ? rechecked.path : null;
        return yield* download(cwd, cacheKey, rechecked);
      }),
    );
  });

  return GitLabProjectAvatarResolver.of({
    resolvePath: (cwd) =>
      resolvePath(cwd).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to resolve GitLab project avatar", { cwd, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
    isManagedPath,
  });
});

export const layer = Layer.effect(GitLabProjectAvatarResolver, make);
