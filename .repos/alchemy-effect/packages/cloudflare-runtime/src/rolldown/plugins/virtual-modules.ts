import {
  EXPORT_TYPES_MODULE_ID,
  exportTypesModuleSource,
  RESOLVED_EXPORT_TYPES_MODULE_ID,
  WORKER_EXPORT_TYPES_EVENT,
} from "../export-types.ts";
import { createPlugin } from "../factory.ts";
import { resolvePluginApi } from "../utils.ts";
import type { UnenvApi } from "./nodejs-compat.ts";

// The export-types module is the one virtual module that is imported by
// specifier (both from the Worker entry and, in dev, by the module runner), so
// the filter has to match it before it has been resolved to its `\0` id.
// oxlint-disable-next-line no-control-regex
const VIRTUAL_MODULE_REGEXP = /^\0?distilled:.*$/;

export const WORKER_ENTRY_PREFIX = "\0distilled:worker-entry:" as const;
const USER_ENTRY_PREFIX = "\0distilled:user-entry:" as const;
const INJECT_PREFIX = "\0distilled:inject:" as const;

/**
 * The id of the generated Worker entry that wraps the user entry `id`.
 *
 * Entry ids are embedded into the specifier and round-tripped through
 * Rolldown/Vite id handling, which expects POSIX-style separators. On Windows
 * the input is an absolute path with `\` separators (e.g. `D:\app\entry.ts`),
 * which would corrupt the virtual id and break resolution. Normalizing to
 * forward slashes is a no-op on POSIX, where ids already use `/`.
 */
export const workerEntryId = (id: string) =>
  `${WORKER_ENTRY_PREFIX}${id.replace(/\\/g, "/")}` as const;

export const virtualModulesPlugin = createPlugin(
  "virtual-modules",
  (options) => {
    let unenvApi: UnenvApi | undefined;
    const inject = () => {
      if (!unenvApi) return [];
      return [
        ...unenvApi.polyfill.map((module) => `import "${module}";`),
        ...Object.keys(unenvApi.inject).map(
          (injectedName) => `import "${INJECT_PREFIX}${injectedName}";`,
        ),
      ];
    };
    return {
      vite: {
        enforce: "pre",
      },
      shared: {
        buildStart({ plugins }) {
          unenvApi = resolvePluginApi<UnenvApi>(
            plugins,
            "distilled-cloudflare:nodejs-unenv",
          );
        },
        resolveId: {
          filter: { id: VIRTUAL_MODULE_REGEXP },
          handler(id) {
            if (
              id === EXPORT_TYPES_MODULE_ID ||
              id === RESOLVED_EXPORT_TYPES_MODULE_ID
            ) {
              return { id: RESOLVED_EXPORT_TYPES_MODULE_ID };
            }
            if (
              id.startsWith(WORKER_ENTRY_PREFIX) ||
              id.startsWith(INJECT_PREFIX)
            ) {
              return { id };
            }
            if (id.startsWith(USER_ENTRY_PREFIX)) {
              return this.resolve(
                id.slice(USER_ENTRY_PREFIX.length),
                undefined,
                {
                  isEntry: true,
                  kind: "import-statement",
                },
              );
            }
          },
        },
        load: {
          filter: { id: VIRTUAL_MODULE_REGEXP },
          handler(id) {
            if (id.startsWith(WORKER_ENTRY_PREFIX)) {
              const userEntryId = id.replace(
                WORKER_ENTRY_PREFIX,
                USER_ENTRY_PREFIX,
              );

              return [
                ...inject(),
                ...(options.exports
                  ? [
                      `export { ${options.exports.join(", ")} } from "${userEntryId}";`,
                    ]
                  : [
                      `import * as userEntry from "${userEntryId}";`,
                      `export * from "${userEntryId}";`,
                      `export default userEntry.default ?? {};`,
                    ]),
                "if (import.meta.hot) {",
                `  const { getExportTypes } = await import("${EXPORT_TYPES_MODULE_ID}");`,
                "  import.meta.hot.accept((module) => {",
                "    const exportTypes = getExportTypes(module);",
                `    import.meta.hot.send("${WORKER_EXPORT_TYPES_EVENT}", exportTypes);`,
                "  });",
                "}",
              ].join("\n");
            }
            if (id === RESOLVED_EXPORT_TYPES_MODULE_ID) {
              return exportTypesModuleSource;
            }
            if (id.startsWith(INJECT_PREFIX)) {
              const injectedName = id.slice(INJECT_PREFIX.length);
              const moduleSpecifier = unenvApi?.inject[injectedName];
              if (!moduleSpecifier) {
                throw new Error(
                  `Expected module specifier for "${injectedName}" to be defined`,
                );
              }
              return [
                `import ${injectedName} from "${moduleSpecifier}";`,
                `globalThis.${injectedName} = ${injectedName};`,
              ].join("\n");
            }
          },
        },
      },
    };
  },
);
