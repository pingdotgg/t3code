// Re-export the router-worker outer and inner entrypoints so the `ctx.exports`
// loopback bindings are preserved in the bundled worker template (enabled by the
// enable_ctx_exports compat flag).
export {
  default,
  RouterInnerEntrypoint,
} from "../../../internal/workers-shared/workers/router-worker/index.ts";
