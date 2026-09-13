/**
 * Marker read by `api-worker.ts`. The stack references that worker by PATH
 * (`main: "./src/api-worker.ts"`) and never imports it, so this module is
 * invisible to `bun --watch`. Rewriting it therefore travels the
 * bundler-only reload path: the local Worker provider's rolldown watch loop
 * rebuilds and hot-swaps the script without the CLI re-running the stack.
 */
export const API_MARKER = "api-v1";
