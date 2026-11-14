import type { Plugin, ViteDevServer } from "vite-plus";

// What the first page load pulls in: the app, the managed-auth shell, the chat
// layout and its landing routes, and the sidebar's project icons.
const STARTUP_LAZY_ENTRIES = [
  "src/main.tsx",
  "src/components/clerk/BrowserManagedAuthShell.tsx",
  "src/routes/_chat.tsx",
  "src/routes/_chat.index.tsx",
  "src/routes/_chat.$environmentId.$threadId.tsx",
  "src/lib/lucideIconByName.ts",
];

const WARMUP_CLIENT_ID = "t3code-startup-warmup";

// Bundled dev keeps these private and untyped. A Vite upgrade that moves them
// skips the warmup or logs a warning, never breaks dev; bundledDev.test.ts
// fails so the upgrade cannot drop the warmup silently.
interface BundledDevInternals {
  waitForInitialBuildFinish(): Promise<void>;
  triggerLazyBundling(
    moduleId: string,
    clientId: string,
  ): Promise<{ readonly filename: string } | undefined>;
  markPayloadDelivered(filename: string): void;
  readonly devEngine: {
    readonly moduleGraph: {
      getModuleIds(): readonly string[];
      getModuleInfo(id: string): { readonly dynamicallyImportedIds: readonly string[] } | null;
    };
    removeClient(clientId: string): Promise<void>;
  };
}

function hasBundledDevInternals(value: unknown): value is BundledDevInternals {
  return (
    typeof value === "object" &&
    value !== null &&
    "waitForInitialBuildFinish" in value &&
    typeof value.waitForInitialBuildFinish === "function" &&
    "triggerLazyBundling" in value &&
    typeof value.triggerLazyBundling === "function" &&
    "markPayloadDelivered" in value &&
    typeof value.markPayloadDelivered === "function"
  );
}

/**
 * Compiles `entries` as lazy chunks once, for a throwaway client, and returns
 * the lazy module ids it compiled. The browser's own requests then reuse
 * Rolldown's transform cache. Entries are paths relative to the Vite root.
 */
async function warmLazyEntries(
  server: ViteDevServer,
  entries: readonly string[],
): Promise<string[]> {
  // Widened so the guard narrows to the internals, not to Vite's public class.
  const bundledDev: unknown = server.environments.client.bundledDev;
  if (!hasBundledDevInternals(bundledDev)) return [];
  await bundledDev.waitForInitialBuildFinish();

  const { moduleGraph } = bundledDev.devEngine;
  // Vite's root and Rolldown's module ids are both absolute, slash-separated paths.
  const wanted = new Set(entries.map((entry) => `${server.config.root}/${entry}`));
  const warmed = new Set<string>();
  // A lazy entry is only in the graph after its parent compiled, so walk in
  // passes. Each pass compiles at least one new wanted id, so it ends.
  const nextLazyIds = () =>
    new Set(
      moduleGraph
        .getModuleIds()
        .flatMap((id) => moduleGraph.getModuleInfo(id)?.dynamicallyImportedIds ?? [])
        .filter(
          (id) =>
            id.includes("rolldown-lazy") && !warmed.has(id) && wanted.has(id.split("?")[0] ?? id),
        ),
    );

  try {
    for (let pending = nextLazyIds(); pending.size > 0; pending = nextLazyIds()) {
      for (const id of pending) {
        warmed.add(id);
        const result = await bundledDev.triggerLazyBundling(id, WARMUP_CLIENT_ID);
        // Acked so the engine drops the pending payload instead of holding the chunk.
        if (result) bundledDev.markPayloadDelivered(result.filename);
      }
    }
  } finally {
    await bundledDev.devEngine.removeClient(WARMUP_CLIENT_ID);
  }
  return [...warmed];
}

// Bundled dev compiles lazy chunks on first request and ignores `server.warmup`.
// Warm them on listening to avoid serial compilation before first paint.
export function warmBundledDevPlugin(): Plugin {
  return {
    name: "t3code:warm-bundled-dev",
    apply: "serve",
    configureServer(server) {
      if (!server.config.experimental.bundledDev) return;
      server.httpServer?.once("listening", () => {
        const startedAt = performance.now();
        warmLazyEntries(server, STARTUP_LAZY_ENTRIES).then(
          (warmed) => {
            if (warmed.length === 0) return;
            const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
            server.config.logger.info(
              `[t3code] pre-bundled ${String(warmed.length)} startup chunks in ${seconds}s`,
              { timestamp: true },
            );
          },
          (error: unknown) => {
            server.config.logger.warn(`[t3code] startup chunk warmup failed: ${String(error)}`, {
              timestamp: true,
            });
          },
        );
      });
    },
  };
}
