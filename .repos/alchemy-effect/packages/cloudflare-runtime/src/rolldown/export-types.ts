/**
 * Cloudflare requires a named export on the deployed Worker for every
 * entrypoint, Durable Object, and Workflow class an application defines. Which
 * classes those are cannot be determined statically — the entry module has to
 * be evaluated and its exports classified by prototype chain.
 *
 * The classification runs inside the Worker (see {@link exportTypesModuleSource})
 * and the result is reported to the dev server over the HMR channel, so a dev
 * server can regenerate its Worker wrappers whenever the exports change.
 */

export type ExportType =
  | "DurableObject"
  | "WorkerEntrypoint"
  | "WorkflowEntrypoint";

/** Maps each named export of a Worker entry to the kind of export it is. */
export type ExportTypes = Record<string, ExportType>;

const EXPORT_TYPES: ReadonlyArray<string> = [
  "DurableObject",
  "WorkerEntrypoint",
  "WorkflowEntrypoint",
] satisfies Array<ExportType>;

/**
 * HMR event the Worker entry uses to report its export types to the dev server.
 */
export const WORKER_EXPORT_TYPES_EVENT =
  "distilled-cloudflare:worker-export-types";

/** Specifier of the virtual module that classifies a Worker entry's exports. */
export const EXPORT_TYPES_MODULE_ID = "distilled:export-types";

/** Resolved id of {@link EXPORT_TYPES_MODULE_ID}. */
export const RESOLVED_EXPORT_TYPES_MODULE_ID = `\0${EXPORT_TYPES_MODULE_ID}`;

/**
 * Source of {@link EXPORT_TYPES_MODULE_ID}. It runs inside the Worker, where
 * `cloudflare:workers` is available, so it is emitted as source rather than
 * imported from here.
 */
export const exportTypesModuleSource = `import {
  DurableObject,
  WorkerEntrypoint,
  WorkflowEntrypoint,
} from "cloudflare:workers";

const baseClasses = [
  ["WorkerEntrypoint", WorkerEntrypoint],
  ["DurableObject", DurableObject],
  ["WorkflowEntrypoint", WorkflowEntrypoint],
];

export function getExportTypes(module) {
  const exportTypes = {};

  for (const [key, value] of Object.entries(module ?? {})) {
    if (key === "default") {
      continue;
    }

    let exportType;

    if (typeof value === "function") {
      for (const [type, baseClass] of baseClasses) {
        if (baseClass.prototype.isPrototypeOf(value.prototype)) {
          exportType = type;
          break;
        }
      }

      // A class that extends none of the base classes is most likely a Durable
      // Object written against the original, non-subclassing API.
      exportType ??= "DurableObject";
    } else if (typeof value === "object" && value !== null) {
      // A plain object export is an \`ExportedHandler\`, i.e. a named entrypoint.
      exportType = "WorkerEntrypoint";
    }

    if (exportType !== undefined) {
      exportTypes[key] = exportType;
    }
  }

  return exportTypes;
}
`;

/**
 * Narrows a value received over the HMR channel to {@link ExportTypes}.
 */
export function isExportTypes(value: unknown): value is ExportTypes {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((type) => EXPORT_TYPES.includes(type as string))
  );
}

/**
 * Returns `true` if any export was added, removed, or changed type.
 */
export function haveExportTypesChanged(
  previous: ExportTypes,
  next: ExportTypes,
): boolean {
  const previousNames = Object.keys(previous);
  const nextNames = Object.keys(next);
  if (previousNames.length !== nextNames.length) {
    return true;
  }
  return nextNames.some((name) => previous[name] !== next[name]);
}
