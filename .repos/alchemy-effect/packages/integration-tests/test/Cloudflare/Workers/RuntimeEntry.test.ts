import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Bridge from "@alchemy.run/cloudflare/Bridge";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { CloudflareEnvironment as RuntimeCloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironmentService";
import {
  makeEffectVirtualEntry,
  WorkerBundle,
} from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import * as WorkerRuntime from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import * as WorkflowRuntime from "@alchemy.run/cloudflare/Workflows/WorkflowRuntime";
import { describe, expect, layer } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { virtualEntryPlugin } from "alchemy/Bundle/Bundle";
import { Stack } from "alchemy/Stack";
import { StackContext } from "alchemy/StackContext";
import * as Telemetry from "alchemy/Telemetry";
import * as TelemetryRuntime from "alchemy/TelemetryRuntime";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import RuntimeEntryWorker from "./fixtures/runtime-entry/worker.ts";

const plannerSources = [
  "alchemy/src/Auth/",
  "alchemy/src/Bundle/",
  "alchemy/src/Local/",
  "alchemy/src/Resource.ts",
  "alchemy/src/Stack.ts",
  "alchemy/src/Telemetry.ts",
  "cloudflare/src/CloudflareEnvironment.ts",
  "cloudflare/src/D1/LocalD1Gateway.ts",
  "cloudflare/src/Local",
  "cloudflare/src/SecretsStore/LocalSecretsStoreGateway.ts",
  "cloudflare/src/Workers/Worker.ts",
  "cloudflare/src/Workflows/Workflow.ts",
  "cloudflare/src/Containers/ContainerBundle.ts",
  "cloudflare/src/Website/Vite.ts",
  "cloudflare/src/Workers/LocalWorkerProvider.ts",
  "cloudflare/src/Workers/Sources/",
  "cloudflare/src/Workers/ViteChild",
  "cloudflare/src/Workers/WorkerProvider.ts",
];

// Paths are relative to `packages/`.
const sourceRoots = ["alchemy/src", "cloudflare/src"];

const toolchainPackages = ["esbuild", "rolldown", "vite", "workerd"];

const packageOf = (id: string) => {
  const segments = id.split(/[\\/]node_modules[\\/]/);
  if (segments.length < 2) return undefined;
  const rest = segments[segments.length - 1]!.split(/[\\/]/);
  return rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
};

const bundleWorkerEntry = Effect.fn(function* (entry: string, generated = false) {
  const path = yield* Path.Path;
  const packagesDir = yield* path.fromFileUrl(new URL("../../../../", import.meta.url));
  const { default: cloudflare } = yield* Effect.promise(
    () => import("@alchemy.run/cloudflare-runtime/rolldown"),
  );
  const { rolldown } = yield* Effect.promise(() => import("rolldown"));
  const virtualEntry = yield* virtualEntryPlugin;
  const graph = new Map<string, { isEntry: boolean; importedIds: readonly string[] }>();
  return yield* Effect.acquireUseRelease(
    Effect.promise(() =>
      rolldown({
        input: path.join(packagesDir, entry),
        // The generated entry's bare imports resolve from the cwd, and only
        // the package that owns the fixtures depends on the providers.
        cwd: path.join(packagesDir, "integration-tests"),
        external: [
          "lightningcss",
          "fsevents",
          // Isolate dependencies added by the generator from the application's imports.
          ...(generated ? [path.join(packagesDir, entry)] : []),
        ],
        plugins: [
          cloudflare({ compatibilityDate: "2025-04-01", compatibilityFlags: ["nodejs_compat"] }),
          generated
            ? virtualEntry(makeEffectVirtualEntry({}, { name: "runtime-entry", stage: "test" }))
            : undefined,
          {
            name: "collect-modules",
            moduleParsed(info) {
              graph.set(info.id, {
                isEntry: info.isEntry,
                importedIds: [...info.importedIds, ...info.dynamicallyImportedIds],
              });
            },
          },
        ],
        checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
        logLevel: "silent",
      }),
    ),
    (bundle) =>
      Effect.gen(function* () {
        const { output } = yield* Effect.promise(() => bundle.generate({ format: "esm" }));
        const chunks = new Map(
          output
            .filter((item) => item.type === "chunk")
            .map((chunk) => [chunk.fileName, chunk] as const),
        );
        const entryChunk = [...chunks.values()].find((chunk) => chunk.isEntry)!;
        // Dynamic imports must not conceal deployment dependencies either.
        const reachableChunks = new Set<string>();
        const chunkQueue = [entryChunk.fileName];
        for (let f = chunkQueue.shift(); f !== undefined; f = chunkQueue.shift()) {
          if (reachableChunks.has(f) || !chunks.has(f)) continue;
          reachableChunks.add(f);
          chunkQueue.push(...chunks.get(f)!.imports, ...chunks.get(f)!.dynamicImports);
        }
        const code = [...reachableChunks].map((f) => chunks.get(f)!.code).join("\n");
        const modules = new Set<string>();
        const queue = [...graph].filter(([, m]) => m.isEntry).map(([id]) => id);
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          if (modules.has(id)) continue;
          modules.add(id);
          queue.push(...(graph.get(id)?.importedIds ?? []));
        }
        const sources = [...modules]
          .filter((id) => sourceRoots.some((root) => id.startsWith(path.join(packagesDir, root))))
          .map((id) => path.relative(packagesDir, id).replaceAll("\\", "/"));
        const packages = new Set([...modules].map(packageOf).filter((name) => name !== undefined));
        return { code, exports: entryChunk.exports, sources, packages };
      }),
    (bundle) => Effect.promise(() => bundle.close()),
  );
});

/**
 * Bundle a fixture with `WorkerBundle` and return the modules rendered into
 * the files the build ships. The collector's `generateBundle` runs before the
 * built-in `unreachableChunksPlugin`, so it also sees chunks that are pruned
 * afterwards; only chunks in the returned output count.
 */
const renderShippedModules = Effect.fn(function* (
  fixture: string,
  entry: { kind: "external" } | { kind: "effect"; exports: {} },
) {
  const path = yield* Path.Path;
  const packagesDir = yield* path.fromFileUrl(new URL("../../../../", import.meta.url));
  const chunks = new Map<string, string[]>();
  const output = yield* (yield* WorkerBundle).build({
    id: "runtime-entry",
    main: path.join(
      packagesDir,
      "integration-tests/test/Cloudflare/Workers/fixtures/runtime-entry",
      fixture,
    ),
    compatibility: { date: "2025-04-01", flags: ["nodejs_compat"] },
    entry,
    stack: { name: "runtime-entry", stage: "test" },
    extraOptions: {
      input: {
        plugins: {
          name: "collect-rendered-modules",
          generateBundle: (_options, bundle) => {
            for (const chunk of Object.values(bundle)) {
              if (chunk.type !== "chunk") continue;
              chunks.set(
                chunk.fileName,
                Object.entries(chunk.modules)
                  .filter(([, module]) => module.renderedLength > 0)
                  .map(([id]) => path.relative(packagesDir, id).replaceAll("\\", "/")),
              );
            }
          },
        },
      },
    },
  });
  return output.files.flatMap((file) => chunks.get(file.path) ?? []);
});

const isPlannerSource = (source: string) =>
  plannerSources.some((prefix) => source.startsWith(prefix));

layer(NodeServices.layer)("@alchemy.run/cloudflare/Bridge (runtime-only entry)", (it) => {
  it.effect(
    "exports the bridge factories the generated Worker entry imports",
    () =>
      Effect.gen(function* () {
        const { exports } = yield* bundleWorkerEntry("cloudflare/src/Bridge.ts");
        expect(exports).toEqual(
          expect.arrayContaining([
            "makeWorkerBridge",
            "makeDurableObjectBridge",
            "makeWorkflowBridge",
            "fromCloudflareFetcher",
            "toRpcAsync",
          ]),
        );
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  it.effect(
    "keeps planner tooling out of /Bridge's dependency graph",
    () =>
      Effect.gen(function* () {
        const { code, sources, packages } = yield* bundleWorkerEntry("cloudflare/src/Bridge.ts");
        expect(sources.filter(isPlannerSource)).toEqual([]);
        expect(toolchainPackages.filter((name) => packages.has(name))).toEqual([]);
        expect(code).not.toContain("require.resolve");
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  it.effect(
    "keeps planner tooling out of imports added by the generated wrapper",
    () =>
      Effect.gen(function* () {
        const { code, sources, packages, exports } = yield* bundleWorkerEntry(
          "integration-tests/test/Cloudflare/Workers/fixtures/runtime-entry/worker.ts",
          true,
        );
        expect(exports).toContain("default");
        expect(sources).toContain("cloudflare/src/Bridge.ts");
        expect(sources.filter(isPlannerSource)).toEqual([]);
        expect(toolchainPackages.filter((name) => packages.has(name))).toEqual([]);
        expect(code).not.toContain("require.resolve");
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  it.effect(
    "keeps the stack builder and auth store out of a bundled Worker",
    () =>
      Effect.gen(function* () {
        const rendered = yield* renderShippedModules("worker.ts", { kind: "external" });
        expect(rendered).toContain("alchemy/src/Resource.ts");
        expect(rendered.filter((id) => /^alchemy\/src\/(Stack\.ts$|Auth\/)/.test(id))).toEqual([]);
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  for (const fixture of ["barrel-worker.ts", "bindings-worker.ts"]) {
    it.effect(
      `keeps the Cloudflare API client out of a bundled Worker (${fixture})`,
      () =>
        Effect.gen(function* () {
          const rendered = yield* renderShippedModules(fixture, { kind: "effect", exports: {} });
          expect(rendered).toContain("cloudflare/src/Workers/WorkerBridge.ts");
          // Deploy-only provider helpers (e.g. `findQueueByName`) reach the
          // distilled clients. `purePlugin` prunes them behind async bindings;
          // the runtime defines alone suffice for the hello-world (#2371).
          expect(
            rendered.filter((id) => /@distilled\.cloud|submodules\/distilled\//.test(id)),
          ).toEqual([]);
        }),
      { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
    );
  }

  it.effect(
    "the @alchemy.run/cloudflare namespace does pull that tooling",
    () =>
      Effect.gen(function* () {
        const { code, sources, packages } = yield* bundleWorkerEntry("cloudflare/src/index.ts");
        expect(sources).toContain("cloudflare/src/Workers/Sources/Rolldown.ts");
        expect(packages.has("workerd")).toBe(true);
        expect(code).toContain("require.resolve");
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  it.effect(
    "detects local tooling behind a dynamic import",
    () =>
      Effect.gen(function* () {
        const { code, sources, packages } = yield* bundleWorkerEntry(
          "integration-tests/test/Cloudflare/Workers/fixtures/runtime-entry/dynamic-tooling.ts",
        );
        expect(sources.filter(isPlannerSource)).toContain("cloudflare/src/LocalRuntime.ts");
        expect(packages.has("workerd")).toBe(true);
        expect(code).toContain("require.resolve");
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  it.effect(
    "preserves the public runtime service identities",
    () =>
      Effect.sync(() => {
        expect(Cloudflare.WorkerEnvironment).toBe(WorkerRuntime.WorkerEnvironment);
        expect(Cloudflare.WorkerExecutionContext).toBe(WorkerRuntime.WorkerExecutionContext);
        expect(Cloudflare.Workflows.WorkflowEvent).toBe(WorkflowRuntime.WorkflowEvent);
        expect(Cloudflare.Workflows.WorkflowStep).toBe(WorkflowRuntime.WorkflowStep);
        expect(Cloudflare.Workflows.WorkflowStepContext).toBe(WorkflowRuntime.WorkflowStepContext);
        expect(CloudflareEnvironment).toBe(RuntimeCloudflareEnvironment);
        expect(Stack.key).toBe(StackContext.key);
        expect(Telemetry.Telemetry).toBe(TelemetryRuntime.Telemetry);
      }),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "provider:cloudflare:workflow",
        "local",
      ],
    },
  );

  it.effect(
    "@alchemy.run/cloudflare still re-exports the same factories",
    () =>
      Effect.sync(() => {
        expect(Cloudflare.makeWorkerBridge).toBe(Bridge.makeWorkerBridge);
        expect(Cloudflare.makeDurableObjectBridge).toBe(Bridge.makeDurableObjectBridge);
        expect(Cloudflare.makeWorkflowBridge).toBe(Bridge.makeWorkflowBridge);
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );
});

for (const dev of [false, true]) {
  describe(
    `runtime entry (${dev ? "local" : "live"})`,
    { tags: ["provider:cloudflare", "provider:cloudflare:worker"] },
    () => {
      const { test } = Test.make({ providers: Cloudflare.providers(), dev });

      test.provider(
        "application importing Worker.ts serves requests",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const worker = yield* stack.deploy(RuntimeEntryWorker);
            const response = yield* requestWorker(HttpClientRequest.get(worker.url!), {
              retryDelay: "3 seconds",
            });
            expect(response.status).toBe(200);
            expect(yield* response.text).toBe(`runtime-entry:${stack.stage}`);
            yield* stack.destroy();
          }),
        { tags: [...(dev ? ["local"] : ["live"])] },
      );
    },
  );
}
