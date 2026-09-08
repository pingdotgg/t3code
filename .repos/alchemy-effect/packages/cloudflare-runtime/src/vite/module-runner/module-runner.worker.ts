import { DurableObject } from "cloudflare:workers";
import {
  ModuleRunner,
  ssrDynamicImportKey,
  ssrModuleExportsKey,
} from "vite/module-runner";
import {
  ENVIRONMENT_NAME_HEADER,
  EXPORT_TYPES_EVENT,
  INIT_PATH,
  REQUEST_EXPORT_TYPES_EVENT,
} from "./constants.shared.ts";
import { stripInternalEnv, type Env } from "./env.worker.ts";

declare global {
  // This global variable is accessed by `@vitejs/plugin-rsc`
  var __VITE_ENVIRONMENT_RUNNER_IMPORT__: (
    environmentName: string,
    id: string,
  ) => Promise<unknown>;
}

const callbacks = {
  nextId: 0,
  pending: new Map<number, () => Promise<unknown>>(),
  results: new Map<number, unknown>(),
  run: async <T>(env: Env, callback: () => Promise<T>): Promise<T> => {
    const id = callbacks.nextId++;
    callbacks.pending.set(id, callback);
    const stub = env.__DISTILLED_MODULE_RUNNER__.get("singleton");
    await stub.executeCallback(id);
    return callbacks.results.get(id) as T;
  },
};

/**
 * Retrieves a specific export from a Worker entry module using the module runner.
 */
export async function getWorkerEntryExport<T>(
  env: Env,
  exportName: string,
): Promise<T> {
  const module = await globalThis.__VITE_ENVIRONMENT_RUNNER_IMPORT__(
    env.__DISTILLED_ENVIRONMENT__.environmentName,
    env.__DISTILLED_ENVIRONMENT__.entryId,
  );

  const exportValue =
    typeof module === "object" &&
    module !== null &&
    exportName in module &&
    (module as Record<string, unknown>)[exportName];

  if (!exportValue) {
    throw new Error(
      `"${env.__DISTILLED_ENVIRONMENT__.entryName}" does not define a "${exportName}" export.`,
    );
  }

  return exportValue as T;
}

export class ModuleRunnerDO extends DurableObject<Env> {
  private webSockets = new Map<string, WebSocket>();
  private moduleRunners = new Map<string, ModuleRunner>();

  async fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if (pathname !== INIT_PATH) {
      throw new Error(`Invalid path: ${pathname}`);
    }
    globalThis.__VITE_ENVIRONMENT_RUNNER_IMPORT__ = async (
      environmentName: string,
      id: string,
    ) => {
      const moduleRunner = this.moduleRunners.get(environmentName);
      if (!moduleRunner) {
        throw new NotInitializedError(environmentName);
      }
      return callbacks.run(this.env, () => moduleRunner.import(id));
    };
    const environmentName = request.headers.get(ENVIRONMENT_NAME_HEADER);
    if (!environmentName) {
      throw new Error(`Missing ${ENVIRONMENT_NAME_HEADER} header`);
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const moduleRunner = this.makeModuleRunner(server, environmentName);
    this.moduleRunners.set(environmentName, moduleRunner);
    // `send()` writes to this socket, which is how `import.meta.hot.send()` in
    // user code reaches the dev server.
    this.webSockets.set(environmentName, server);
    server.addEventListener("message", ({ data }) => {
      if (isRequestExportTypes(data)) {
        void this.reportExportTypes(environmentName);
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(environmentName: string, data: string): void {
    const webSocket = this.webSockets.get(environmentName);
    if (!webSocket) {
      throw new NotInitializedError(environmentName);
    }
    webSocket.send(data);
  }

  /**
   * Evaluates the Worker entry and reports how each of its exports should be
   * wrapped. The dev server needs this before it can serve a request, so the
   * import runs here rather than being driven from user code.
   */
  private async reportExportTypes(environmentName: string): Promise<void> {
    const { entryId, exportTypesId } = this.env.__DISTILLED_ENVIRONMENT__;
    let data: unknown;
    try {
      // Both imports run inside this object's IoContext, so they can go
      // straight to the module runner instead of through `callbacks`.
      const { getExportTypes } = (await this.import(
        environmentName,
        exportTypesId,
      )) as {
        getExportTypes: (module: unknown) => Record<string, string>;
      };
      data = getExportTypes(await this.import(environmentName, entryId));
    } catch (error) {
      // A reply still goes out so the dev server does not wait out its timeout.
      // The entry failing to evaluate is reported to the user through the
      // request that triggered it; the dev server keeps its current export
      // types.
      // oxlint-disable-next-line no-console
      console.error(
        "Failed to determine the Worker entry's export types:",
        error,
      );
      data = null;
    }
    this.send(
      environmentName,
      JSON.stringify({ type: "custom", event: EXPORT_TYPES_EVENT, data }),
    );
  }

  private async import(environmentName: string, id: string): Promise<unknown> {
    const moduleRunner = this.moduleRunners.get(environmentName);
    if (!moduleRunner) {
      throw new NotInitializedError(environmentName);
    }
    return await moduleRunner.import(id);
  }

  async executeCallback(id: number): Promise<void> {
    const callback = callbacks.pending.get(id);
    if (!callback) {
      throw new Error(`No pending callback with id ${id}`);
    }
    const result = await callback();
    callbacks.results.set(id, result);
  }

  makeModuleRunner(webSocket: WebSocket, environmentName: string) {
    const env = this.env;
    return new ModuleRunner(
      {
        sourcemapInterceptor: "prepareStackTrace",
        transport: {
          connect({ onMessage }) {
            webSocket.addEventListener("message", async ({ data }) => {
              onMessage(JSON.parse(data.toString()));
            });

            onMessage({
              type: "custom",
              event: "vite:ws:connect",
              data: { webSocket },
            });
          },
          disconnect() {
            webSocket.close();
          },
          async send(data) {
            // We send messages via a binding to the Durable Object.
            // This is because `import.meta.send` may be called within a Worker's request context.
            // Directly using a WebSocket created in another context would be forbidden.
            const stub = env.__DISTILLED_MODULE_RUNNER__.get("singleton");
            stub.send(environmentName, JSON.stringify(data));
          },
          invoke: async (data) => {
            const response = await env.__DISTILLED_INVOKE_MODULE__.fetch(
              new Request("http://localhost", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  [ENVIRONMENT_NAME_HEADER]: environmentName,
                },
                body: JSON.stringify(data),
              }),
            );
            const result = await response.json<
              { result: unknown } | { error: unknown }
            >();

            return result;
          },
        },
        hmr: true,
      },
      {
        runInlinedModule: async (context, transformed, module) => {
          // Wrap dynamic imports to route deferred dynamic imports
          // through the DO's IoContext.
          const originalDynamicImport = context[ssrDynamicImportKey];
          context[ssrDynamicImportKey] = (dep) => {
            return callbacks.run(env, () => originalDynamicImport(dep));
          };

          // The trailing newline ensures a `//` comment on the last line of
          // `transformed` (e.g. a sourceMappingURL comment preserved by
          // vite-plus) cannot swallow the closing brace.
          const code = `"use strict";async (${Object.keys(context).join(",")})=>{${transformed}\n}`;
          try {
            const fn = env.__DISTILLED_UNSAFE_EVAL__.eval(code, module.id);
            await fn(...Object.values(context));
            Object.seal(context[ssrModuleExportsKey]);
          } catch (error) {
            // oxlint-disable-next-line no-console
            console.error(
              `[vite-plugin] Failed to evaluate inlined module "${module.id}":`,
              error,
            );
            throw error;
          }
        },
        runExternalModule: async (filepath) => {
          if (filepath === "cloudflare:workers") {
            const { env, ...mod } = await import("cloudflare:workers");
            return Object.seal({
              ...mod,
              env: stripInternalEnv(env as Env),
            });
          }
          return await import(filepath);
        },
      },
    );
  }
}

function isRequestExportTypes(data: string | ArrayBuffer): boolean {
  if (typeof data !== "string" || !data.includes(REQUEST_EXPORT_TYPES_EVENT)) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(data);
    return (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { event?: unknown }).event === REQUEST_EXPORT_TYPES_EVENT
    );
  } catch {
    return false;
  }
}

class NotInitializedError extends Error {
  constructor(environmentName: string) {
    super(
      `Module runner not initialized for environment: "${environmentName}". If this is a child environment, make sure to set \`childEnvironments: ["${environmentName}"]\` in the plugin config.`,
    );
  }
}
