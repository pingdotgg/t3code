// @effect-diagnostics nodeBuiltinImport:off - Vite resolves module paths before an Effect runtime exists.
import * as NodePath from "node:path";

import { normalizePath, type HtmlTagDescriptor, type Plugin, type Rolldown } from "vite-plus";

// What a cold open runs before its first commit: the app, then the chat
// layout, home, a draft, or a thread. Keep in sync with src/routes.
const STARTUP_MODULES = {
  main: "src/main.tsx",
  chat: "src/routes/_chat.tsx?tsr-split=component",
  "chat-index": "src/routes/_chat.index.tsx?tsr-split=component",
  "chat-draft": "src/routes/_chat.draft.$draftId.tsx?tsr-split=component",
  "chat-thread": "src/routes/_chat.$environmentId.$threadId.tsx?tsr-split=component",
};
/**
 * Groups the startup graphs into a few chunks while preserving route boundaries.
 *
 * index.html loads `src/bootstrap.ts`, which imports `src/main.tsx` lazily so
 * it can show boot errors. Left alone, the browser learns the main graph only
 * after that entry runs and the route chunks only after the auth check, and
 * both arrive as hundreds of small shared chunks.
 *
 * Listing main and the startup routes as build inputs lets Rolldown tag their
 * static graphs `$initial` after tree shaking. A module belongs to the first
 * startup graph that imports it. Chat modules that other pages (settings, usage,
 * welcome) or the shell's lazy parts (the root notices, the command palette)
 * also import move into one chunk per set of those users. A settings or welcome
 * cold open then downloads only the chat code it uses, and a chat cold open
 * fetches those few extra chunks in the same wave. index.html preloads main's
 * static graph; the router preloads the initial location's route chunks
 * alongside authentication.
 * The bootstrap entry keeps its own modules, so it never statically imports
 * a startup chunk and can still report a failed load.
 */
// Transformed code size below which a set of shared chat modules joins main.
const MAIN_SHARED_SET_SIZE = 100_000;
const sharedChunkName = (owner: string | undefined) =>
  owner === undefined || owner in STARTUP_MODULES ? null : owner;

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
                  {
                    // The chat modules other pages also render; see buildEnd.
                    name: (id: string) =>
                      sharedChunkName(startupModuleOwners.get(normalizePath(id))),
                    debugName: "startup-shared",
                    tags: ["$initial" as const],
                    test: (id: string) =>
                      !id.startsWith("\0") &&
                      sharedChunkName(startupModuleOwners.get(normalizePath(id))) !== null,
                    entriesAware: false,
                    includeDependenciesRecursively: false,
                  },
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
      const codeLength = (id: string) =>
        this.getModuleInfo(moduleIds.get(id) ?? id)?.code?.length ?? 0;
      // Other pages and the app shell also load chat modules: route pages outside
      // the chat layout, grouped by family since settings.general renders inside
      // settings, and the shell's lazy parts, such as the root notices.
      const startupEntries = new Set(
        Object.values(STARTUP_MODULES).map((entry) => normalizePath(NodePath.join(root, entry))),
      );
      const routesDir = normalizePath(NodePath.join(root, "src/routes/"));
      const families = new Map<string, Array<string>>();
      for (const id of staticClosure(normalizePath(NodePath.join(root, STARTUP_MODULES.main)))) {
        for (const lazyId of this.getModuleInfo(moduleIds.get(id) ?? id)?.dynamicallyImportedIds ??
          []) {
          const entry = normalizePath(lazyId);
          const route = entry.startsWith(routesDir)
            ? entry.slice(routesDir.length).split(/[.?]/)[0]
            : undefined;
          // `_` routes render inside the chat layout.
          if (startupEntries.has(entry) || route?.startsWith("_")) continue;
          const family = route ?? entry;
          families.set(family, [...(families.get(family) ?? []), entry]);
        }
      }
      const familyGraphs = [...families].map(
        ([family, entries]) =>
          [NodePath.basename(family).split(".")[0], staticClosure(...entries)] as const,
      );
      // Each set of families that uses a chat module gets one chunk, so a page or
      // lazy part downloads only the chat code it uses. A set's chunk imports only
      // chunks of its supersets, which every family in it also needs.
      const setSizes = new Map<string, number>();
      for (const [id, owner] of owners) {
        if (owner === "main") continue;
        const users = familyGraphs.filter(([, graph]) => graph.has(id)).map(([family]) => family);
        if (users.length === 0) continue;
        const set = `${[...new Set(users)].sort().join("-")}-shared`;
        owners.set(id, set);
        setSizes.set(set, (setSizes.get(set) ?? 0) + codeLength(id));
      }
      // Small sets join main instead of adding requests to every chat cold open.
      // A module moves only when everything it imports is in main or moves too,
      // so main never imports a shared chunk.
      const toMain = new Set(
        [...owners].flatMap(([id, owner]) =>
          (setSizes.get(owner) ?? Infinity) < MAIN_SHARED_SET_SIZE ? [id] : [],
        ),
      );
      for (let changed = true; changed;) {
        changed = false;
        for (const id of toMain) {
          const imports = this.getModuleInfo(moduleIds.get(id) ?? id)?.importedIds ?? [];
          if (
            imports.some((dependency) => {
              const owner = owners.get(normalizePath(dependency));
              return (
                owner !== undefined && owner !== "main" && !toMain.has(normalizePath(dependency))
              );
            })
          ) {
            toMain.delete(id);
            changed = true;
          }
        }
      }
      for (const id of toMain) owners.set(id, "main");
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
        // index.html already loads the bootstrap entry and its imports.
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
        // The main entry can become a facade after grouping. Preload its
        // static dependencies only; selected routes retain their own preload lists.
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
        // Largest first: those downloads take longest.
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

/**
 * lucide-react/dynamic imports each of ~1,900 icons lazily. When the app also
 * imports one of those icons statically, Rolldown keeps it as a dynamic entry
 * in a chunk of its own, which put ~140 one-icon files on the startup path.
 * A query suffix gives the lazy copies their own module ids, so static imports
 * bundle normally and only icons picked at runtime load as separate files.
 */
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
