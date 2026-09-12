import { loadInternalWorker } from "../core/internal/internal-worker.ts";
import type { ExportTypes } from "../rolldown/export-types.ts";
import { EXPORT_TYPES_MODULE_ID } from "../rolldown/export-types.ts";
import { MODULE_REFERENCE_REGEX } from "../rolldown/plugins/index.ts";
import type { BindingHooks, Module } from "../core/index.ts";
import * as Runtime from "../core/Runtime.ts";
import * as RuntimeServices from "../core/RuntimeServices.ts";
import * as DurableObjectNamespace from "../core/bindings/DurableObjectNamespace.ts";
import * as Json from "../core/bindings/Json.ts";
import * as Loopback from "../core/bindings/Loopback.ts";
import * as UnsafeEval from "../core/bindings/UnsafeEval.ts";
import { PlatformServices } from "../Platform.ts";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodeFs from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as vite from "vite";
const ModuleRunnerWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-vite-worker/module-runner/module-runner.worker",
    ),
};
const WrapperWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-vite-worker/module-runner/wrapper.worker",
    ),
};
import * as ViteAssets from "./assets/ViteAssets.ts";
import { renderExportWrappers } from "./export-types.ts";
import type { EntryEnvironment } from "./module-runner/constants.shared.ts";
import { ENVIRONMENT_NAME_HEADER } from "./module-runner/constants.shared.ts";
import type { CloudflareVitePluginOptions } from "./plugin.ts";

export type ServerHandle = Awaited<ReturnType<typeof startServer>>;

export const startServer = async <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  entryEnvironment: Omit<EntryEnvironment, "exportTypesId">,
  server: vite.ViteDevServer,
  context: Context.Context<RuntimeServices.RuntimeServices>,
  exportTypes: ExportTypes,
) => {
  const scope = Scope.makeUnsafe();
  const address = await serve(
    options,
    entryEnvironment,
    server,
    exportTypes,
  ).pipe(
    // `provideMerge`: the assets layer's construction reads `Loopback` (and
    // friends) from the runtime context, so the context must feed the layer,
    // not just sit beside it.
    Effect.provide(
      ViteAssets.ViteAssetsLive(server).pipe(
        Layer.provideMerge(Layer.succeedContext(context)),
      ),
    ),
    Scope.provide(scope),
    Effect.runPromise,
  );
  return {
    address,
    close: () => closeScope(scope),
  };
};

export const createDefaultContext = async (): Promise<
  Context.Context<RuntimeServices.RuntimeServices>
> => {
  const scope = Scope.makeUnsafe();

  return await RuntimeServices.layerRuntime({
    api: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    },
  }).pipe(
    Layer.provideMerge(PlatformServices),
    Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
    Layer.buildWithScope(scope),
    Effect.runPromise,
  );
};

const closeScope = async (scope: Scope.Scope) => {
  await Effect.runPromiseExit(
    Scope.closeUnsafe(scope, Exit.void) ?? Effect.void,
  );
};

const makeModuleFallbackService = Effect.gen(function* () {
  const server = NodeHttp.createServer(async (req, res) => {
    try {
      const request = await parseModuleFallbackRequest(req);
      if (!request) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid module fallback request");
        return;
      }

      const candidate = request.rawSpecifier ?? request.specifier;
      const match = MODULE_REFERENCE_REGEX.exec(candidate);
      if (!match) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`No match for module: ${candidate}`);
        return;
      }

      const [, moduleType, modulePath] = match;
      if (!moduleType || !modulePath) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Invalid module type or path: ${match[0]}`);
        return;
      }

      let content: Buffer;
      try {
        content = await NodeFs.readFile(modulePath);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`Module not found: ${modulePath}`);
        return;
      }

      switch (moduleType) {
        case "CompiledWasm": {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ wasm: Array.from(content) }));
          return;
        }
        case "Data": {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: Array.from(content) }));
          return;
        }
        case "Text": {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: content.toString() }));
          return;
        }
        default: {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Invalid module type: ${moduleType}`);
        }
      }
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    }
  });

  // workerd fetches every fallback module over this server. Node's default
  // 5s `keepAliveTimeout` closes idle sockets between module bursts, forcing
  // workerd to open a fresh TCP connection per burst — on Windows CI the
  // resulting TIME_WAIT churn exhausts ephemeral ports (WSAENOBUFS #10055).
  // Keep idle connections around for a minute so they get reused.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
  });
  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      // `close()` waits for in-flight/keep-alive connections; destroy them so
      // shutdown doesn't hang for up to `keepAliveTimeout`.
      server.closeAllConnections();
    }),
  );

  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.die(
      new Error("Module fallback server address unavailable"),
    );
  }
  return `127.0.0.1:${address.port}`;
});

const serve = Effect.fn(function* <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  entryEnvironment: Omit<EntryEnvironment, "exportTypesId">,
  server: vite.ViteDevServer,
  exportTypes: ExportTypes,
) {
  const runtime = yield* Runtime.Runtime;
  const moduleFallback = yield* makeModuleFallbackService;

  const name = options.worker?.name ?? `vite-dev-${crypto.randomUUID()}`;
  return yield* runtime.start({
    name,
    modules: yield* Effect.promise(() => makeWorkerModules(exportTypes)),
    compatibilityDate: options.compatibilityDate ?? "2026-05-12",
    compatibilityFlags: options.compatibilityFlags ?? [],
    bindings: [
      UnsafeEval.local("__DISTILLED_UNSAFE_EVAL__"),
      DurableObjectNamespace.local({
        binding: "__DISTILLED_MODULE_RUNNER__",
        className: "ModuleRunnerDO",
      }),
      Json.local("__DISTILLED_ENVIRONMENT__", {
        ...entryEnvironment,
        exportTypesId: EXPORT_TYPES_MODULE_ID,
      } satisfies EntryEnvironment),
      Loopback.local({
        binding: "__DISTILLED_INVOKE_MODULE__",
        name: `vite:invoke-module:${name}`,
        handler: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const targetEnvironment = Headers.get(
            request.headers,
            ENVIRONMENT_NAME_HEADER,
          ).pipe(Option.getOrThrow);
          const json = (yield* request.json) as unknown as vite.CustomPayload;
          const devEnvironment = server.environments[targetEnvironment];
          const result = yield* Effect.promise(
            async () => await devEnvironment.hot.handleInvoke(json),
          );
          return HttpServerResponse.jsonUnsafe(result);
        }),
      }),
      ...(options.worker?.bindings ?? []),
    ],
    durableObjectNamespaces: [
      {
        className: "ModuleRunnerDO",
        sql: false,
        ephemeralLocal: true,
      },
      ...(options.worker?.durableObjectNamespaces ?? []),
    ],
    workflows: options.worker?.workflows,
    hyperdrives: options.worker?.hyperdrives,
    // Without this the worker starts with no consumers, so a producer
    // binding for a queue this worker consumes resolves to the dev-registry
    // proxy instead of a local broker — and that accepts-and-drops every
    // message, with `send()` never settling.
    queueConsumers: options.worker?.queueConsumers,
    assets: options.worker?.assets,
    unsafe: {
      moduleFallback,
      ...(options.worker?.unsafe ?? {}),
    },
  });
});

type ModuleFallbackRequest =
  | {
      protocol: "v1";
      type: "import" | "require";
      specifier: string;
      rawSpecifier?: string;
      referrer?: string;
    }
  | {
      protocol: "v2";
      type: "import" | "require" | "internal";
      specifier: string;
      rawSpecifier?: string;
      referrer?: string;
      attributes?: Array<{ name: string; value: string }>;
    };

const parseModuleFallbackRequest = async (
  req: NodeHttp.IncomingMessage,
): Promise<ModuleFallbackRequest | undefined> => {
  if (req.method === "GET" && req.headers["x-resolve-method"]) {
    const url = new URL(req.url ?? "", "http://localhost");
    const specifier = url.searchParams.get("specifier");
    if (!specifier) {
      return;
    }
    const resolveMethod = req.headers["x-resolve-method"];
    return {
      protocol: "v1",
      type: resolveMethod === "require" ? "require" : "import",
      specifier,
      rawSpecifier: url.searchParams.get("rawSpecifier") ?? undefined,
      referrer: url.searchParams.get("referrer") ?? undefined,
    };
  }

  if (req.method === "POST") {
    const chunks: Array<Buffer> = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof json === "object" && json !== null && "specifier" in json) {
      return {
        protocol: "v2",
        ...(json as Omit<
          Extract<ModuleFallbackRequest, { protocol: "v2" }>,
          "protocol"
        >),
      };
    }
  }
};

async function makeWorkerModules(
  exportTypes: ExportTypes,
): Promise<Array<Module>> {
  const [moduleRunnerWorker, wrapperWorker] = await Promise.all([
    ModuleRunnerWorker.worker(),
    WrapperWorker.worker(),
  ]);
  const modules = {
    "index.worker.mjs": [
      `import { createWorkerEntrypointWrapper, createDurableObjectWrapper, createWorkflowEntrypointWrapper } from "./module-runner/wrapper.worker.mjs";`,
      'export { ModuleRunnerDO } from "./module-runner/module-runner.worker.mjs";',
      'export default createWorkerEntrypointWrapper("default");',
      ...renderExportWrappers(exportTypes),
    ].join("\n"),
    ...moduleRunnerWorker.modules,
    ...wrapperWorker.modules,
  };
  return Object.entries(modules).map(([name, content]) => ({
    name,
    type: "ESModule",
    content,
  }));
}
