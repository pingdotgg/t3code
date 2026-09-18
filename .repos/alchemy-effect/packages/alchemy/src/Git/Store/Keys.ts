/**
 * R2 key scheme (DESIGN.md §3.2).
 *
 * All R2 keys are **immutable and content-addressed** — this sidesteps the
 * 1-write/s/key limit, makes conditional-put re-runs (idempotent alarm jobs)
 * safe, and makes cross-repo fork references safe: a fork's `objects.r2_key`
 * may point into the parent repo's prefix, since the bytes at a key never
 * change once written.
 *
 * ```
 * {repoId}/objects/{oid}            oversize loose objects, zlib(content)
 * {repoId}/packs/pack-{sha1}.pack   v1.1 compaction output
 * {repoId}/incoming/{pushId}.pack   v1.x streaming-push tee (reserved)
 * {repoId}/lfs/{sha256}             LFS objects (reserved)
 * ```
 *
 * `list()` is never used on a hot path — the `objects` table is the sole
 * inventory. The prefix helpers exist for the delete-purge and GC alarm jobs
 * only.
 */

/**
 * R2 key for an oversize loose object: `{repoId}/objects/{oid}`.
 *
 * The stored bytes are `zlib(content)` without the loose header — byte-equal
 * to what an `objects.location = 'row'` row would hold in `zdata`.
 */
export const objectKey = (repoId: string, oid: string): string =>
  `${repoId}/objects/${oid}`;

/**
 * R2 key for a compacted pack (v1.1): `{repoId}/packs/pack-{sha1}.pack`.
 * The `sha1` is the pack's trailer checksum, making the key content-addressed.
 */
export const packKey = (repoId: string, sha: string): string =>
  `${repoId}/packs/pack-${sha}.pack`;

/**
 * R2 key of a clone bundle for a ref snapshot (DESIGN.md §12.2):
 * `{repoId}/bundles/bundle-{refsHash}.pack`. Immutable and
 * content-addressed by the refs it covers, so it is safe to cache at the
 * edge and safe to write concurrently.
 */
export const bundleKey = (repoId: string, refsHash: string): string =>
  `${repoId}/bundles/bundle-${refsHash}.pack`;

/**
 * The bundle's **pre-framed** twin (DESIGN §22.4): the same pack already
 * cut into band-1 sideband frames of exactly 65515 data bytes. Real git
 * always negotiates `side-band-64k`, and bytes that cross into JS to be
 * framed measured a hard ~15 MiB/s ceiling regardless of how the framing
 * was written; this twin lets the sideband case be a platform-to-platform
 * pipe like the raw case. Written alongside the bundle, immutable, same
 * lifecycle (purged with the prefix).
 */
export const bundleSidebandKey = (repoId: string, refsHash: string): string =>
  `${repoId}/bundles/bundle-${refsHash}.sideband`;

/**
 * R2 key for a streamed incoming push pack (v1.x upgrade seam, DESIGN.md
 * §3.6): `{repoId}/incoming/{pushId}.pack`. Reserved — unused in v1's
 * buffered ingest.
 */
export const incomingKey = (repoId: string, pushId: string): string =>
  `${repoId}/incoming/${pushId}.pack`;

/**
 * Pack-id prefix of a **promoted wire pack** (DESIGN §22.5): a push whose
 * body spilled to blob storage already holds every non-delta blob in the
 * compaction layout (`typeSize header + zdata`), so ingest points those
 * rows straight into the incoming object instead of copying 40 MiB of
 * blobs through SQLite and compacting them out again later. The pack id
 * is `wire-<receiveId>`; the object stays at its `incomingKey`.
 */
export const WIRE_PACK_PREFIX = "wire-";
export const wirePackId = (receiveId: string): string =>
  `${WIRE_PACK_PREFIX}${receiveId}`;
export const isWirePackId = (packId: string): boolean =>
  packId.startsWith(WIRE_PACK_PREFIX);

/** R2 key of any pack by id — compacted (`packKey`) or promoted wire pack. */
export const packKeyOf = (repoId: string, packId: string): string =>
  isWirePackId(packId)
    ? incomingKey(repoId, packId.slice(WIRE_PACK_PREFIX.length))
    : packKey(repoId, packId);

/**
 * R2 key reserved for a future LFS object (DESIGN.md §10):
 * `{repoId}/lfs/{sha256}`.
 */
export const lfsKey = (repoId: string, sha256: string): string =>
  `${repoId}/lfs/${sha256}`;

/**
 * The whole-repo R2 prefix (`{repoId}/`) — the unit the delete-purge alarm
 * job lists and deletes (retained while the Registry reports
 * `fork_count > 0`, since forks reference keys under it).
 */
export const repoPrefix = (repoId: string): string => `${repoId}/`;

/**
 * Prefix of all oversize loose objects for a repo: `{repoId}/objects/`.
 */
export const objectsPrefix = (repoId: string): string => `${repoId}/objects/`;

/**
 * Prefix of all compacted packs for a repo (v1.1): `{repoId}/packs/`.
 */
export const packsPrefix = (repoId: string): string => `${repoId}/packs/`;

/**
 * Prefix of all in-flight streamed push packs for a repo (reserved):
 * `{repoId}/incoming/`.
 */
export const incomingPrefix = (repoId: string): string => `${repoId}/incoming/`;

/**
 * Prefix of all LFS objects for a repo (reserved): `{repoId}/lfs/`.
 */
export const lfsPrefix = (repoId: string): string => `${repoId}/lfs/`;

/**
 * R2 key of a repo's head snapshot (DESIGN.md §21): a small JSON object
 * describing the current refs, visibility, and clone bundle, written by
 * the Repo DO after every mutation commit. Lets the Worker serve
 * anonymous public reads (advertisement + bundle clones) without waking
 * the DO. Lives under the repo prefix so purge drains it.
 */
export const headKey = (repoId: string): string => `${repoId}/head`;
