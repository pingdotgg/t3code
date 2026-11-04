export { PATH_MODULE_RUNNER_INIT as INIT_PATH } from "../../core/globals/EntryOptions.shared.ts";
export const ENVIRONMENT_NAME_HEADER = "distilled-environment-name";
export const WORKER_ENTRY_PATH_HEADER = "distilled-worker-entry-path";

/**
 * Sent by the dev server over the module runner WebSocket to ask the Worker to
 * evaluate the entry module and classify its exports. The reply comes back as
 * {@link EXPORT_TYPES_EVENT}.
 *
 * This runs over the module runner channel rather than an HTTP endpoint so it
 * cannot be intercepted by the asset router that sits in front of the Worker.
 */
export const REQUEST_EXPORT_TYPES_EVENT = "distilled-cloudflare:request-export-types";

/** Reply to {@link REQUEST_EXPORT_TYPES_EVENT}, carrying an `ExportTypes` payload. */
export const EXPORT_TYPES_EVENT = "distilled-cloudflare:export-types";

/**
 * `Symbol.for` key of the {@link EntryEnvironment} the generated entry module
 * sets on `globalThis`. A JSON binding would also land in the Worker's `env`
 * and, with `nodejs_compat_populate_process_env`, its `process.env`.
 */
export const ENTRY_ENVIRONMENT_KEY = "distilled-cloudflare:entry-environment";

export interface EntryEnvironment {
  environmentName: string;
  entryId: string;
  entryName: string;
  /** Id of the virtual module that classifies the entry module's exports. */
  exportTypesId: string;
}

/**
 * Marks a Worker's uncaught `fetch` error, serialized as JSON, for the dev
 * server to revive into Vite's error page (Miniflare's
 * `MF-Experimental-Error-Stack`).
 */
export const HEADER_ERROR_STACK = "MF-Experimental-Error-Stack";
