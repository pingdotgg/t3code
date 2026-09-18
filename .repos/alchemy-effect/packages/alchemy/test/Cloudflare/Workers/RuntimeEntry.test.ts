import { virtualEntryPlugin } from "@/Bundle/Bundle";
import * as Cloudflare from "@/Cloudflare";
import * as Bridge from "@/Cloudflare/Bridge";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { CloudflareEnvironment as RuntimeCloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironmentService";
import * as WorkerRuntime from "@/Cloudflare/Workers/WorkerRuntime";
import * as WorkflowRuntime from "@/Cloudflare/Workflows/WorkflowRuntime";
import { Stack } from "@/Stack";
import { StackContext } from "@/StackContext";
import * as Telemetry from "@/Telemetry";
import * as TelemetryRuntime from "@/TelemetryRuntime";
import { makeEffectVirtualEntry } from "@/Cloudflare/Workers/Sources/Rolldown";
import * as Test from "@/Test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RuntimeEntryWorker from "./fixtures/runtime-entry/worker.ts";

const plannerSources = [
  "src/Auth/",
  "src/Bundle/",
  "src/Local/",
  "src/Resource.ts",
  "src/Stack.ts",
  "src/Telemetry.ts",
  "src/Cloudflare/CloudflareEnvironment.ts",
  "src/Cloudflare/D1/LocalD1Gateway.ts",
  "src/Cloudflare/Local",
  "src/Cloudflare/SecretsStore/LocalSecretsStoreGateway.ts",
  "src/Cloudflare/Workers/Worker.ts",
  "src/Cloudflare/Workflows/Workflow.ts",
  "src/Cloudflare/Containers/ContainerBundle.ts",
  "src/Cloudflare/Website/Vite.ts",
  "src/Cloudflare/Workers/LocalWorkerProvider.ts",
  "src/Cloudflare/Workers/Sources/",
  "src/Cloudflare/Workers/ViteChild",
  "src/Cloudflare/Workers/WorkerProvider.ts",
];

const toolchainPackages = ["esbuild", "rolldown", "vite", "workerd"];

const packageOf = (id: string) => {
  const segments = id.split(/[\\/]node_modules[\\/]/);
  if (segments.length < 2) return undefined;
  const rest = segments[segments.length - 1]!.split(/[\\/]/);
  return rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
};

const bundleWorkerEntry = Effect.fn(function* (
  entry: string,
  generated = false,
) {
  const path = yield* Path.Path;
  const packageRoot = yield* path.fromFileUrl(
    new URL("../../../", import.meta.url),
  );
  const { default: cloudflare } = yield* Effect.promise(
    () => import("@alchemy.run/cloudflare-runtime/rolldown"),
  );
  const { rolldown } = yield* Effect.promise(() => import("rolldown"));
  const virtualEntry = yield* virtualEntryPlugin;
  const graph = new Map<
    string,
    { isEntry: boolean; importedIds: readonly string[] }
  >();
  return yield* Effect.acquireUseRelease(
    Effect.promise(() =>
      rolldown({
        input: path.join(packageRoot, entry),
        cwd: packageRoot,
        external: [
          "lightningcss",
          "fsevents",
          // Isolate dependencies added by the generator from the application's imports.
          ...(generated ? [path.join(packageRoot, entry)] : []),
        ],
        plugins: [
          cloudflare({
            compatibilityDate: "2025-04-01",
            compatibilityFlags: ["nodejs_compat"],
          }),
          generated
            ? virtualEntry(
                makeEffectVirtualEntry(
                  {},
                  { name: "runtime-entry", stage: "test" },
                ),
              )
            : undefined,
          {
            name: "collect-modules",
            moduleParsed(info) {
              graph.set(info.id, {
                isEntry: info.isEntry,
                importedIds: [
                  ...info.importedIds,
                  ...info.dynamicallyImportedIds,
                ],
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
        const { output } = yield* Effect.promise(() =>
          bundle.generate({ format: "esm" }),
        );
        const chunks = new Map(
          output
            .filter((item) => item.type === "chunk")
            .map((chunk) => [chunk.fileName, chunk] as const),
        );
        const entryChunk = [...chunks.values()].find((chunk) => chunk.isEntry)!;
        // Dynamic imports must not conceal deployment dependencies either.
        const reachableChunks = new Set<string>();
        const chunkQueue = [entryChunk.fileName];
        for (
          let f = chunkQueue.shift();
          f !== undefined;
          f = chunkQueue.shift()
        ) {
          if (reachableChunks.has(f) || !chunks.has(f)) continue;
          reachableChunks.add(f);
          chunkQueue.push(
            ...chunks.get(f)!.imports,
            ...chunks.get(f)!.dynamicImports,
          );
        }
        const code = [...reachableChunks]
          .map((f) => chunks.get(f)!.code)
          .join("\n");
        const modules = new Set<string>();
        const queue = [...graph].filter(([, m]) => m.isEntry).map(([id]) => id);
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          if (modules.has(id)) continue;
          modules.add(id);
          queue.push(...(graph.get(id)?.importedIds ?? []));
        }
        const sources = [...modules]
          .filter((id) => id.startsWith(path.join(packageRoot, "src")))
          .map((id) => path.relative(packageRoot, id).replaceAll("\\", "/"));
        const packages = new Set(
          [...modules].map(packageOf).filter((name) => name !== undefined),
        );
        return { code, exports: entryChunk.exports, sources, packages };
      }),
    (bundle) => Effect.promise(() => bundle.close()),
  );
});

const isPlannerSource = (source: string) =>
  plannerSources.some((prefix) => source.startsWith(prefix));

layer(NodeServices.layer)(
  "alchemy/Cloudflare/Bridge (runtime-only entry)",
  (it) => {
    it.effect(
      "exports the bridge factories the generated Worker entry imports",
      () =>
        Effect.gen(function* () {
          const { exports } = yield* bundleWorkerEntry(
            "src/Cloudflare/Bridge.ts",
          );
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
    );

    it.effect("keeps planner tooling out of /Bridge's dependency graph", () =>
      Effect.gen(function* () {
        const { code, sources, packages } = yield* bundleWorkerEntry(
          "src/Cloudflare/Bridge.ts",
        );
        expect(sources.filter(isPlannerSource)).toEqual([]);
        expect(toolchainPackages.filter((name) => packages.has(name))).toEqual(
          [],
        );
        expect(code).not.toContain("require.resolve");
      }),
    );

    it.effect(
      "keeps planner tooling out of imports added by the generated wrapper",
      () =>
        Effect.gen(function* () {
          const { code, sources, packages, exports } = yield* bundleWorkerEntry(
            "test/Cloudflare/Workers/fixtures/runtime-entry/worker.ts",
            true,
          );
          expect(exports).toContain("default");
          expect(sources).toContain("src/Cloudflare/Bridge.ts");
          expect(sources.filter(isPlannerSource)).toEqual([]);
          expect(
            toolchainPackages.filter((name) => packages.has(name)),
          ).toEqual([]);
          expect(code).not.toContain("require.resolve");
        }),
    );

    it.effect("the alchemy/Cloudflare namespace does pull that tooling", () =>
      Effect.gen(function* () {
        const { code, sources, packages } = yield* bundleWorkerEntry(
          "src/Cloudflare/index.ts",
        );
        expect(sources).toContain("src/Cloudflare/Workers/Sources/Rolldown.ts");
        expect(packages.has("workerd")).toBe(true);
        expect(code).toContain("require.resolve");
      }),
    );

    it.effect("detects local tooling behind a dynamic import", () =>
      Effect.gen(function* () {
        const { code, sources, packages } = yield* bundleWorkerEntry(
          "test/Cloudflare/Workers/fixtures/runtime-entry/dynamic-tooling.ts",
        );
        expect(sources.filter(isPlannerSource)).toContain(
          "src/Cloudflare/LocalRuntime.ts",
        );
        expect(packages.has("workerd")).toBe(true);
        expect(code).toContain("require.resolve");
      }),
    );

    it.effect("preserves the public runtime service identities", () =>
      Effect.sync(() => {
        expect(Cloudflare.WorkerEnvironment).toBe(
          WorkerRuntime.WorkerEnvironment,
        );
        expect(Cloudflare.WorkerExecutionContext).toBe(
          WorkerRuntime.WorkerExecutionContext,
        );
        expect(Cloudflare.Workflows.WorkflowEvent).toBe(
          WorkflowRuntime.WorkflowEvent,
        );
        expect(Cloudflare.Workflows.WorkflowStep).toBe(
          WorkflowRuntime.WorkflowStep,
        );
        expect(Cloudflare.Workflows.WorkflowStepContext).toBe(
          WorkflowRuntime.WorkflowStepContext,
        );
        expect(CloudflareEnvironment).toBe(RuntimeCloudflareEnvironment);
        expect(Stack.key).toBe(StackContext.key);
        expect(Telemetry.Telemetry).toBe(TelemetryRuntime.Telemetry);
      }),
    );

    it.effect("alchemy/Cloudflare still re-exports the same factories", () =>
      Effect.sync(() => {
        expect(Cloudflare.makeWorkerBridge).toBe(Bridge.makeWorkerBridge);
        expect(Cloudflare.makeDurableObjectBridge).toBe(
          Bridge.makeDurableObjectBridge,
        );
        expect(Cloudflare.makeWorkflowBridge).toBe(Bridge.makeWorkflowBridge);
      }),
    );
  },
);

for (const dev of [false, true]) {
  describe(`runtime entry (${dev ? "local" : "live"})`, () => {
    const { test } = Test.make({ providers: Cloudflare.providers(), dev });

    test.provider("application importing Worker.ts serves requests", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const worker = yield* stack.deploy(RuntimeEntryWorker);
        const client = yield* HttpClient.HttpClient;
        const body = yield* client.get(worker.url!).pipe(
          Effect.flatMap((response) => response.text),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 8,
            until: (body) => body === "runtime-entry:ok",
          }),
        );
        expect(body).toBe("runtime-entry:ok");
        yield* stack.destroy();
      }),
    );
  });
}
