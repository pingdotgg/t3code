/**
 * alchemy/Git — a Git hosting service on Cloudflare Workers,
 * Durable Objects, and R2, built with Alchemy Effect-native Workers.
 *
 * Public surface:
 * - The HTTP contract ({@link GitApi}, aliased {@link Api}): every plane as
 *   one `HttpApi`, each endpoint an `HttpApiEndpoint`, each group a
 *   class, with the schemas and tagged errors.
 * - {@link Handlers} and {@link ApiHandlersLive}: shared handler implementations.
 *   {@link ApiLive} registers public routes; merge it beside application routes.
 *   {@link GroupsLive} exposes native group implementations for overrides.
 * - {@link Engine}: transport-independent operations, with scoped prepare/commit
 *   for application authorization and validation. HTTP codecs live in `alchemy/Git/Http`.
 * - The deployable pieces: {@link ApiLive} + {@link InternalApiLive}, the
 *   {@link GitRepo} / {@link Registry} Durable Objects, and the storage and
 *   hasher blocks.
 *
 * Internals (wire-protocol codecs under `Protocol/`, storage under `Store/`,
 * alarm jobs under `Jobs/`) are deliberately not re-exported here — deep
 * import them via `alchemy/Git/Protocol/Pkt.ts` style paths when
 * needed.
 */
export * from "./Api.ts";
export { GitApi as Api } from "./Api.ts";
export { Engine, EngineLive } from "./Engine.ts";
export type { PushInput, PreparedPush, RefUpdate } from "./Push.ts";
export * as Http from "./Http.ts";
export * as Push from "./PushInput.ts";
export * from "./Server.ts";
export {
  parseCommit,
  parseTree,
  ZERO_OID,
  ObjectType,
} from "./Protocol/ObjectCodec.ts";
export { StoreError } from "./Protocol/Store.ts";
export { WireProtocolError, PackIngestError } from "./RepoObject.ts";
export {
  BlobStore,
  BlobStoreR2,
  BlobStoreError,
  type BlobBody,
  type BlobMeta,
  type BlobMultipart,
  type BlobStoreShape,
} from "./BlobStore.ts";
export { BlobStoreS3 } from "./BlobStoreS3.ts";
export { RegistryD1 } from "./RegistryD1.ts";
export {
  GitRepo,
  GitRepoLive,
  MAX_PACK_BYTES,
  type CommitPushInput,
  type CommitPushResult,
  type GitRepoShape,
  type RepoMetaData,
  RepoStore,
  type RepoStoreShape,
  type RepoStub,
} from "./RepoObject.ts";
export {
  Registry,
  RegistryDurableObject,
  RegistryLive,
  RegistryStore,
  REGISTRY_DO_NAME,
  RESERVED_OWNERS,
} from "./RegistryObject.ts";

export {
  Hasher,
  HasherInline,
  HasherSelf,
  HASHER_BINDING,
} from "./Hasher/Hasher.ts";
