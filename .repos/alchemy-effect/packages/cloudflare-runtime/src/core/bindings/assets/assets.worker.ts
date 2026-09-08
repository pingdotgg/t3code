// Re-export the asset-worker so that its contents gets compiled into cloudflare-runtime.
// AssetWorkerInner must be explicitly re-exported so that the bundled module exposes it
// via ctx.exports (enabled by the enable_ctx_exports compat flag).
export {
  AssetWorkerInner,
  default,
} from "../../../internal/workers-shared/workers/asset-worker/index.ts";
