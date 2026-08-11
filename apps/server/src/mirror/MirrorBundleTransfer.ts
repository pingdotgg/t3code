/**
 * MirrorBundleTransfer - signed HTTP transfer of git bundles.
 *
 * Bundle bytes never cross the RPC WebSocket. The host stages bundles under
 * `<mirrorsDir>/.staging` and hands out short-lived HMAC-signed URLs (the
 * asset-access pattern): the origin agent PUTs sync/seed bundles up and GETs
 * apply-back bundles down. The signed token is the entire authorization.
 *
 * @module MirrorBundleTransfer
 */
import type { MirrorSyncId, ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

export const MIRROR_BUNDLE_ROUTE_PREFIX = "/api/mirror/bundle";

const SIGNING_SECRET_NAME = "mirror-bundle-signing-key";
const BUNDLE_TOKEN_TTL_MS = 30 * 60 * 1000;

const MirrorBundleClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("mirror-bundle"),
  projectId: Schema.String,
  syncId: Schema.String,
  direction: Schema.Literals(["upload", "download"]),
  expiresAt: Schema.Number,
});
type MirrorBundleClaims = typeof MirrorBundleClaimsSchema.Type;

const MirrorBundleClaimsJson = Schema.fromJsonString(MirrorBundleClaimsSchema);
const decodeBundleClaims = Schema.decodeUnknownOption(MirrorBundleClaimsJson);
const encodeBundleClaims = Schema.encodeSync(MirrorBundleClaimsJson);

function decodeClaims(encodedPayload: string): MirrorBundleClaims | null {
  try {
    return Option.getOrNull(decodeBundleClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

export class MirrorBundleSigningError extends Schema.TaggedErrorClass<MirrorBundleSigningError>()(
  "MirrorBundleSigningError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the mirror bundle signing key.";
  }
}

export interface ResolvedBundleTransfer {
  readonly direction: "upload" | "download";
  readonly projectId: string;
  readonly syncId: string;
  /** Absolute staging path the request reads from or writes to. */
  readonly bundlePath: string;
}

export class MirrorBundleTransfer extends Context.Service<
  MirrorBundleTransfer,
  {
    /** Absolute staging path for a sync's bundle file. */
    readonly stagingPath: (syncId: MirrorSyncId) => Effect.Effect<string>;
    readonly issueUrl: (input: {
      readonly projectId: ProjectId;
      readonly syncId: MirrorSyncId;
      readonly direction: "upload" | "download";
    }) => Effect.Effect<
      { readonly relativeUrl: string; readonly expiresAt: string },
      MirrorBundleSigningError
    >;
    /**
     * Validate a route token for the expected direction. Tokens are
     * single-use: a second request with the same token is rejected. A
     * request using the wrong method (and thus the wrong direction) fails
     * before the token is consumed, so the legitimate request can still
     * succeed.
     */
    readonly resolve: (
      token: string,
      expectedDirection: "upload" | "download",
    ) => Effect.Effect<ResolvedBundleTransfer | null>;
    readonly removeStaged: (syncId: MirrorSyncId) => Effect.Effect<void>;
    /**
     * Record the cumulative byte count of an in-flight bundle upload.
     * Called by the HTTP PUT route as chunks arrive; `totalBytes` is the
     * request's Content-Length, null when the uploader streamed without one.
     */
    readonly trackUpload: (input: {
      readonly projectId: string;
      readonly syncId: string;
      readonly bytes: number;
      readonly totalBytes: number | null;
    }) => Effect.Effect<void>;
    readonly clearUpload: (syncId: string) => Effect.Effect<void>;
    /** Latest in-flight upload progress for a project, null when idle. */
    readonly uploadProgressForProject: (
      projectId: string,
    ) => Effect.Effect<{ readonly bytes: number; readonly totalBytes: number | null } | null>;
  }
>()("t3/mirror/MirrorBundleTransfer") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const stagingDir = path.join(config.mirrorsDir, ".staging");
  yield* fileSystem.makeDirectory(stagingDir, { recursive: true });

  // Single-use guard keyed by token payload; entries expire with the token.
  // In-memory only: a server restart within a token's (now 30-minute) TTL
  // clears this and lets an already-consumed token be replayed once more.
  // Accepted trade-off — the replay window is bounded by the TTL and
  // requires the attacker to already hold a captured signed URL; closing it
  // fully would mean persisting consumed-token state.
  const usedTokens = yield* SynchronizedRef.make<ReadonlyMap<string, number>>(new Map());

  const loadSigningSecret = secretStore
    .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
    .pipe(Effect.mapError((cause) => new MirrorBundleSigningError({ cause })));

  const stagingPath: MirrorBundleTransfer["Service"]["stagingPath"] = (syncId) =>
    Effect.succeed(path.join(stagingDir, `${syncId}.bundle`));

  const issueUrl: MirrorBundleTransfer["Service"]["issueUrl"] = Effect.fn(
    "MirrorBundleTransfer.issueUrl",
  )(function* (input) {
    const signingSecret = yield* loadSigningSecret;
    const expiresAt = (yield* Clock.currentTimeMillis) + BUNDLE_TOKEN_TTL_MS;
    const claims: MirrorBundleClaims = {
      version: 1,
      kind: "mirror-bundle",
      projectId: input.projectId,
      syncId: input.syncId,
      direction: input.direction,
      expiresAt,
    };
    const encodedPayload = base64UrlEncode(encodeBundleClaims(claims));
    const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
    return {
      relativeUrl: `${MIRROR_BUNDLE_ROUTE_PREFIX}/${token}`,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
    };
  });

  const resolve: MirrorBundleTransfer["Service"]["resolve"] = Effect.fn(
    "MirrorBundleTransfer.resolve",
  )(function* (token, expectedDirection) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) return null;
    const signingSecret = yield* loadSigningSecret.pipe(Effect.orElseSucceed(() => null));
    if (!signingSecret) return null;
    if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) {
      return null;
    }
    const claims = decodeClaims(encodedPayload);
    const now = yield* Clock.currentTimeMillis;
    if (!claims || claims.expiresAt <= now) return null;
    // Checked before consuming the token: a wrong-method request (e.g. a
    // GET against an upload URL) must not burn the single legitimate use.
    if (claims.direction !== expectedDirection) return null;

    const firstUse = yield* SynchronizedRef.modify(usedTokens, (current) => {
      const pruned = new Map(Array.from(current).filter(([, expiry]) => expiry > now));
      if (pruned.has(encodedPayload)) return [false, pruned] as const;
      pruned.set(encodedPayload, claims.expiresAt);
      return [true, pruned] as const;
    });
    if (!firstUse) return null;

    return {
      direction: claims.direction,
      projectId: claims.projectId,
      syncId: claims.syncId,
      bundlePath: path.join(stagingDir, `${claims.syncId}.bundle`),
    } satisfies ResolvedBundleTransfer;
  });

  const removeStaged: MirrorBundleTransfer["Service"]["removeStaged"] = (syncId) =>
    fileSystem
      .remove(path.join(stagingDir, `${syncId}.bundle`), { force: true })
      .pipe(Effect.ignore);

  // In-flight upload byte counts, keyed by syncId. Purely in-memory: an
  // entry lives from the first PUT chunk to clearUpload (request end).
  const uploads = yield* SynchronizedRef.make<
    ReadonlyMap<
      string,
      { readonly projectId: string; readonly bytes: number; readonly totalBytes: number | null }
    >
  >(new Map());

  const trackUpload: MirrorBundleTransfer["Service"]["trackUpload"] = (input) =>
    SynchronizedRef.update(uploads, (current) => {
      const next = new Map(current);
      next.set(input.syncId, {
        projectId: input.projectId,
        bytes: input.bytes,
        totalBytes: input.totalBytes,
      });
      return next;
    });

  const clearUpload: MirrorBundleTransfer["Service"]["clearUpload"] = (syncId) =>
    SynchronizedRef.update(uploads, (current) => {
      if (!current.has(syncId)) return current;
      const next = new Map(current);
      next.delete(syncId);
      return next;
    });

  const uploadProgressForProject: MirrorBundleTransfer["Service"]["uploadProgressForProject"] = (
    projectId,
  ) =>
    SynchronizedRef.get(uploads).pipe(
      Effect.map((current) => {
        for (const entry of current.values()) {
          if (entry.projectId === projectId) {
            return { bytes: entry.bytes, totalBytes: entry.totalBytes };
          }
        }
        return null;
      }),
    );

  return MirrorBundleTransfer.of({
    stagingPath,
    issueUrl,
    resolve,
    removeStaged,
    trackUpload,
    clearUpload,
    uploadProgressForProject,
  });
});

export const layer = Layer.effect(MirrorBundleTransfer, make);

/** Inert transfer for tests: every token resolves to nothing. */
export const layerTest = Layer.succeed(
  MirrorBundleTransfer,
  MirrorBundleTransfer.of({
    stagingPath: (syncId) => Effect.succeed(`/dev/null/${syncId}.bundle`),
    issueUrl: () =>
      Effect.succeed({
        relativeUrl: `${MIRROR_BUNDLE_ROUTE_PREFIX}/test`,
        expiresAt: "1970-01-01T00:00:00.000Z",
      }),
    resolve: () => Effect.succeed(null),
    removeStaged: () => Effect.void,
    trackUpload: () => Effect.void,
    clearUpload: () => Effect.void,
    uploadProgressForProject: () => Effect.succeed(null),
  }),
);
