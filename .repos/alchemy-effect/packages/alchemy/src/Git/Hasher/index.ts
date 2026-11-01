/**
 * `alchemy/Git/Hasher` — every pack hasher implementation (DESIGN §22).
 * The contract and the cloud-neutral layers ({@link HasherInline},
 * {@link HasherSelf}) are also re-exported from `alchemy/Git`; this entry
 * adds the ones that bring their own compute: {@link HasherLambda} (an AWS
 * Lambda per chunk) and {@link HasherWorkerLoader} (dynamically loaded
 * Workers). It is a separate entry so a Git Worker that hashes inline never
 * bundles them.
 */
export {
  Hasher,
  HasherInline,
  HasherSelf,
  HASHER_BINDING,
  makeInlineHasher,
  type HasherShape,
  type HashPartOptions,
  type HashPartResult,
} from "./Hasher.ts";
export { HashError, HASH_ROUTE } from "./Protocol.ts";
export { HasherLambda } from "./Lambda.ts";
export { default as HasherFunction } from "./LambdaFunction.ts";
export {
  boundScan,
  decodeHashResponse,
  encodeHashEvent,
  handleHashEvent,
  isHashEvent,
  LAMBDA_CHUNK_BYTES,
  RESPONSE_BUDGET_BYTES,
  type HashEvent,
  type HashResponse,
} from "./LambdaEvent.ts";
export {
  HasherWorkerLoader,
  LOADER_CHUNK_BYTES,
  LOADER_MAX_CONCURRENCY,
  type HasherWorkerLoaderOptions,
} from "./WorkerLoader.ts";
