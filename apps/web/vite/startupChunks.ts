// @effect-diagnostics nodeBuiltinImport:off - Vite resolves module paths before an Effect runtime exists.
import * as NodePath from "node:path";

import { normalizePath, type HtmlTagDescriptor, type Plugin, type Rolldown } from "vite-plus";

// Keep the initial route graphs in sync with src/routes.
const STARTUP_MODULES = {
  main: "src/main.tsx",
  chat: "src/routes/_chat.tsx?tsr-split=component",
  "chat-index": "src/routes/_chat.index.tsx?tsr-split=component",
  "chat-draft": "src/routes/_chat.draft.$draftId.tsx?tsr-split=component",
  "chat-thread": "src/routes/_chat.$environmentId.$threadId.tsx?tsr-split=component",
};
// Group static startup graphs without pulling chat-only code into other routes.
// Bootstrap stays separate so it can report main's chunk-load failures.

export function startupChunksPlugin(): Plugin {
  let root = process.cwd();
  let base = "/";
  let bootstrapModules: ReadonlySet<string> = new Set();
  let startupModuleOwners: ReadonlyMap<string, string> = new Map();
  let startupFiles: ReadonlyArray<string> = [];
  let startupFileSet: ReadonlySet<string> = new Set();
  let startupCss: ReadonlyArray<string> = [];

  return {
    name: "t3code:startup-chunks",
    apply: "build",
    config: (config) => {
      root = normalizePath(NodePath.resolve(config.root ?? process.cwd()));
      return {
        build: {
          modulePreload: {
            resolveDependencies: (_file, deps, { hostType }) =>
              hostType === "js" ? deps.filter((dep) => !startupFileSet.has(dep)) : deps,
          },
          rolldownOptions: {
            input: {
              index: normalizePath(NodePath.join(root, "index.html")),
              ...Object.fromEntries(
                Object.entries(STARTUP_MODULES).map(([name, id]) => [
                  name,
                  normalizePath(NodePath.join(root, id)),
                ]),
              ),
            },
            output: {
              codeSplitting: {
                // Keep each graph whole: size splitting creates chunk cycles inside Effect's
                // eagerly initialized runtime and can run consumers before their dependencies.
                groups: [
                  ...Object.keys(STARTUP_MODULES).map((name) => ({
                    name: `startup-${name}`,
                    tags: ["$initial" as const],
                    test: (id: string) =>
                      !id.startsWith("\0") && startupModuleOwners.get(normalizePath(id)) === name,
                    // Dynamic settings/theme entries must not fragment the startup graphs.
                    entriesAware: false,
                    // Otherwise excluded bootstrap helpers are recaptured through main's imports.
                    includeDependenciesRecursively: false,
                  })),
                ],
              },
            },
          },
        },
      };
    },
    configResolved(config) {
      base = config.base;
    },
    buildEnd(error) {
      if (error) return;
      const moduleIds = new Map([...this.getModuleIds()].map((id) => [normalizePath(id), id]));
      const staticClosure = (...entryIds: ReadonlyArray<string>) => {
        const closure = new Set<string>();
        const pending = entryIds.flatMap((entryId) => moduleIds.get(entryId) ?? []);
        for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
          const normalizedId = normalizePath(id);
          if (closure.has(normalizedId)) continue;
          closure.add(normalizedId);
          pending.push(...(this.getModuleInfo(id)?.importedIds ?? []));
        }
        return closure;
      };
      bootstrapModules = staticClosure(normalizePath(NodePath.join(root, "index.html")));
      const owners = new Map<string, string>();
      for (const [name, entry] of Object.entries(STARTUP_MODULES)) {
        for (const id of staticClosure(normalizePath(NodePath.join(root, entry)))) {
          if (!bootstrapModules.has(id) && !owners.has(id)) owners.set(id, name);
        }
      }
      startupModuleOwners = owners;
    },
    generateBundle: {
      order: "pre",
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter(
          (output): output is Rolldown.OutputChunk => output.type === "chunk",
        );
        const importClosure = (roots: ReadonlyArray<Rolldown.OutputChunk>) => {
          const files = new Set<string>();
          const pending = roots.map((chunk) => chunk.fileName);
          for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
            const chunk = bundle[file];
            if (chunk?.type !== "chunk" || files.has(file)) continue;
            files.add(file);
            pending.push(...chunk.imports);
          }
          return files;
        };
        const bootstrapFiles = importClosure(
          chunks.filter(
            (chunk) => chunk.facadeModuleId === normalizePath(NodePath.join(root, "index.html")),
          ),
        );
        const mainId = normalizePath(NodePath.join(root, STARTUP_MODULES.main));
        if (
          [...bootstrapFiles].some((file) => {
            const chunk = bundle[file];
            return (
              chunk?.type === "chunk" &&
              chunk.moduleIds.some(
                (id) => !id.startsWith("\0") && !bootstrapModules.has(normalizePath(id)),
              )
            );
          })
        ) {
          this.error(
            "The boot entry must catch main's chunk load failures before importing app code.",
          );
        }
        // Main may become a facade; routes retain their own preload lists.
        const files = [
          ...importClosure(
            chunks.filter(
              (chunk) => chunk.facadeModuleId === mainId || chunk.moduleIds.includes(mainId),
            ),
          ),
        ].filter((file) => !bootstrapFiles.has(file));
        const chunkAt = (file: string) => {
          const chunk = bundle[file];
          return chunk?.type === "chunk" ? chunk : undefined;
        };
        startupFiles = files.toSorted(
          (left, right) => (chunkAt(right)?.code.length ?? 0) - (chunkAt(left)?.code.length ?? 0),
        );
        startupFileSet = new Set(startupFiles);
        startupCss = [
          ...new Set(
            files.flatMap((file) => [...(chunkAt(file)?.viteMetadata?.importedCss ?? [])]),
          ),
        ];
      },
    },
    transformIndexHtml: {
      order: "post",
      handler: (): HtmlTagDescriptor[] => [
        // A stylesheet link would hold the splash until the CSS arrives; the
        // runtime still inserts the stylesheet before main runs.
        ...startupCss.map((file): HtmlTagDescriptor => ({
          tag: "link",
          attrs: { rel: "preload", as: "style", crossorigin: true, href: `${base}${file}` },
          injectTo: "head",
        })),
        ...startupFiles.map((file): HtmlTagDescriptor => ({
          tag: "link",
          attrs: { rel: "modulepreload", crossorigin: true, href: `${base}${file}` },
          injectTo: "head",
        })),
      ],
    },
  };
}

// Separate dynamic icon ids so static icons don't each become a startup chunk.
export function lucideDynamicIconsPlugin(): Plugin {
  const suffix = "?lucide-dynamic";
  return {
    name: "t3code:lucide-dynamic-icons",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!source.startsWith("./icons/") || !importer?.endsWith("/dynamicIconImports.js")) {
        return null;
      }
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      return resolved ? `${resolved.id}${suffix}` : null;
    },
  };
}
