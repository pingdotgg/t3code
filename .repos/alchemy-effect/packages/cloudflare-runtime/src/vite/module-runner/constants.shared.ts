export const INIT_PATH = "/__vite_module_runner/init";
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
export const REQUEST_EXPORT_TYPES_EVENT =
  "distilled-cloudflare:request-export-types";

/** Reply to {@link REQUEST_EXPORT_TYPES_EVENT}, carrying an `ExportTypes` payload. */
export const EXPORT_TYPES_EVENT = "distilled-cloudflare:export-types";

export interface EntryEnvironment {
  environmentName: string;
  entryId: string;
  entryName: string;
  /** Id of the virtual module that classifies the entry module's exports. */
  exportTypesId: string;
}
