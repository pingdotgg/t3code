import type { ExportType, ExportTypes } from "../rolldown/export-types.ts";
import type { CloudflareVitePluginOptions } from "./plugin.ts";

const WRAPPER_FACTORIES = {
  DurableObject: "createDurableObjectWrapper",
  WorkerEntrypoint: "createWorkerEntrypointWrapper",
  WorkflowEntrypoint: "createWorkflowEntrypointWrapper",
} satisfies Record<ExportType, string>;

const IDENTIFIER_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Names the generated Worker entry already uses, and which therefore cannot be
 * taken over by a user export.
 */
const RESERVED_EXPORT_NAMES = new Set(["default", "ModuleRunnerDO"]);

/**
 * The export types that follow from the plugin options alone.
 *
 * Durable Object and Workflow classes have to be declared up front because
 * workerd needs their namespaces at startup, so they are known before the entry
 * module has ever been evaluated. Named entrypoints have no such declaration
 * and can only be discovered by classifying the entry's exports.
 */
export function configuredExportTypes(
  options: CloudflareVitePluginOptions,
): ExportTypes {
  const exportTypes: ExportTypes = {};
  for (const namespace of options.worker?.durableObjectNamespaces ?? []) {
    exportTypes[namespace.className] = "DurableObject";
  }
  for (const workflow of options.worker?.workflows ?? []) {
    exportTypes[workflow.className] = "WorkflowEntrypoint";
  }
  return exportTypes;
}

/**
 * Combines detected export types with the configured ones. Configuration wins:
 * a class declared as a Durable Object namespace must be wrapped as one even if
 * it is momentarily broken and classifies as something else.
 */
export function mergeExportTypes(
  configured: ExportTypes,
  detected: ExportTypes,
): ExportTypes {
  return { ...detected, ...configured };
}

/**
 * Renders the wrapper exports for the generated Worker entry.
 *
 * An export whose name is not a valid identifier (`export { x as "a-b" }`)
 * cannot be re-exported by the wrapper module, so it is skipped rather than
 * emitting a module that fails to parse.
 */
export function renderExportWrappers(exportTypes: ExportTypes): Array<string> {
  return Object.entries(exportTypes)
    .filter(
      ([name]) =>
        IDENTIFIER_REGEX.test(name) && !RESERVED_EXPORT_NAMES.has(name),
    )
    .map(
      ([name, type]) =>
        `export const ${name} = ${WRAPPER_FACTORIES[type]}("${name}");`,
    );
}
