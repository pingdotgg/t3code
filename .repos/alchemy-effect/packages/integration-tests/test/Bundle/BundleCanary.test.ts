import { makeFunctionBundler } from "@alchemy.run/aws/Lambda/FunctionBundle";
import {
  buildMicrovmDockerfile,
  bundleMicrovmProgram,
} from "@alchemy.run/aws/Lambda/MicrovmBundle";
import { getCompatibility } from "@alchemy.run/cloudflare/Workers/Compatibility";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import { expect, it, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Bundle from "alchemy/Bundle/Bundle";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";

/**
 * Canary over the bundles Alchemy ships: each fixture is bundled with the
 * exact options its provider deploys with, and the test checks how much of
 * the module graph Rolldown had to parse, how big the output is, and which
 * provider services ended up in it.
 *
 * Every runtime fixture comes in two styles — `import * as AWS from
 * "@alchemy.run/aws"` and per-service imports (`@alchemy.run/aws/Lambda`) —
 * and both must cost the same: `lazyBarrel` plus the namespace-import rewrite
 * keep the root barrel from pulling every service into the build.
 */

const fixture = (name: string) => `${import.meta.dirname}/fixtures/canary/${name}`;

interface BundleStats {
  /** Modules Rolldown parsed (the cost of a build: time and memory). */
  readonly parsed: ReadonlyArray<string>;
  /** Modules that ended up in the output chunks. */
  readonly bundled: ReadonlyArray<string>;
  /** Total bytes of JavaScript emitted (source maps excluded). */
  readonly bytes: number;
  /** Total bytes of source maps emitted. */
  readonly mapBytes: number;
}

/** A plugin that records {@link BundleStats} for the build it is added to. */
const measure = () => {
  const parsed: string[] = [];
  const bundled: string[] = [];
  let bytes = 0;
  let mapBytes = 0;
  const plugin: rolldown.Plugin = {
    name: "canary:measure",
    moduleParsed(info) {
      parsed.push(info.id);
    },
    // After Alchemy's own `generateBundle` hooks, which drop unreachable
    // chunks: measure what actually ships.
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === "asset") {
            if (output.fileName.endsWith(".map")) mapBytes += output.source.length;
            continue;
          }
          bundled.push(...Object.keys(output.modules));
          bytes += output.code.length;
        }
      },
    },
  };
  return { plugin, stats: (): BundleStats => ({ parsed, bundled, bytes, mapBytes }) };
};

/** The provider service directories (`AWS/S3`, `Cloudflare/KV`, …) a set of modules comes from. */
const servicesOf = (modules: ReadonlyArray<string>, pkg: "aws" | "cloudflare") => {
  const re = new RegExp(`[\\\\/]packages[\\\\/]${pkg}[\\\\/]src[\\\\/]([^\\\\/]+)[\\\\/]`);
  return [...new Set(modules.flatMap((id) => re.exec(id)?.[1] ?? []))].sort();
};

const bundleLambda = (main: string) =>
  Effect.gen(function* () {
    const { resolveBundlePlan } = yield* makeFunctionBundler;
    const { plugin, stats } = measure();
    const plan = yield* resolveBundlePlan({ main, build: { plugins: [plugin] } });
    yield* Bundle.build(plan.inputOptions, plan.outputOptions, plan.extra);
    return stats();
  });

const bundleWorker = (main: string) =>
  Effect.gen(function* () {
    const bundler = yield* WorkerBundle;
    const { plugin, stats } = measure();
    yield* bundler.build({
      id: "CanaryWorker",
      main,
      compatibility: getCompatibility({ main }),
      entry: { kind: "effect", exports: {} },
      stack: { name: "BundleCanary", stage: "test" },
      extraOptions: { input: { plugins: [plugin] } },
    });
    return stats();
  });

const bundleMicrovm = (main: string) =>
  Effect.gen(function* () {
    const { plugin, stats } = measure();
    const { files } = yield* bundleMicrovmProgram({
      main,
      runtime: "node",
      port: 8080,
      build: { input: { plugins: [plugin] } },
    }).pipe(
      Effect.provideService(Stack, {
        name: "BundleCanary",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
    );
    return { stats: stats(), files };
  });

/**
 * Writes a Node MicroVM bundle to disk and runs it the way its image's
 * entrypoint does (`node --enable-source-maps index.mjs`), returning a GET
 * against the running server. The process is killed when the scope closes.
 */
const bootMicrovm = (files: ReadonlyArray<{ path: string; content: Uint8Array }>, port: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bundle-canary-microvm-" });
    yield* Effect.forEach(files, (file) => fs.writeFile(path.join(dir, file.path), file.content));
    yield* ChildProcess.make("node", ["--enable-source-maps", "index.mjs"], {
      cwd: dir,
      // Placeholder credentials: the bootstrap resolves them on start, and
      // without any it would wait on the instance metadata endpoint.
      env: {
        PORT: String(port),
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "canary",
        AWS_SECRET_ACCESS_KEY: "canary",
      },
      extendEnv: true,
    });
    const client = yield* HttpClient.HttpClient;
    return (route: string) =>
      client.get(`http://127.0.0.1:${port}${route}`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.timeout("2 seconds"),
        // The server takes a moment to start listening.
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
      );
  });

interface Budget {
  /** Most modules Rolldown may parse for this runtime. */
  readonly parsed: number;
  /** Most JavaScript bytes the runtime may ship. */
  readonly bytes: number;
  /** Most source-map bytes the runtime may ship. */
  readonly mapBytes: number;
  /** The provider services whose code ships in the bundle — no others. */
  readonly services: ReadonlyArray<string>;
  /** Modules this runtime must not ship, on top of {@link DEPLOY_ONLY}. */
  readonly forbidden?: ReadonlyArray<RegExp>;
}

const report = (label: string, stats: BundleStats, pkg: "aws" | "cloudflare") =>
  Effect.log(
    `${label}: parsed=${stats.parsed.length} bundled=${stats.bundled.length} bytes=${stats.bytes} mapBytes=${stats.mapBytes} services=${servicesOf(stats.bundled, pkg).join(",")}`,
  );

/**
 * Deploy-time code that must never ship in a runtime: the bundler, the CLI's
 * platform layer (Bun's platform came with it), and profile and credential
 * stores. `Auth/Registry.ts` is the exception: `Stack.ts` provides it, and it
 * imports nothing but Effect.
 */
const DEPLOY_ONLY = [
  /[\\/](rolldown|@rolldown)[\\/]/,
  /[\\/]@effect[\\/]platform-bun[\\/]/,
  /[\\/]alchemy[\\/]src[\\/](Auth[\\/](?!Registry\.ts$)|Cli[\\/]|Bundle[\\/])/,
  /[\\/]alchemy[\\/]src[\\/](EvalStack|Deploy|Destroy|Plan|Apply)\.ts$/,
];

const expectWithinBudget = (stats: BundleStats, pkg: "aws" | "cloudflare", budget: Budget) => {
  expect(stats.parsed.length).toBeLessThanOrEqual(budget.parsed);
  expect(stats.bytes).toBeLessThanOrEqual(budget.bytes);
  expect(stats.mapBytes).toBeLessThanOrEqual(budget.mapBytes);
  expect(servicesOf(stats.bundled, pkg)).toEqual(budget.services);
  const forbidden = [...DEPLOY_ONLY, ...(budget.forbidden ?? [])];
  expect(stats.bundled.filter((id) => forbidden.some((re) => re.test(id)))).toEqual([]);
};

/**
 * `ns.Service` still loads that one service's barrel in full, so the
 * namespace style may parse somewhat more than the per-service style —
 * never another provider's worth (before `lazyBarrel` and the rewrite,
 * `import * as AWS` parsed ~8,500 modules against ~800).
 */
const expectSameCost = (namespace: BundleStats, subpath: BundleStats) => {
  expect(namespace.parsed.length).toBeLessThanOrEqual(Math.ceil(subpath.parsed.length * 1.25));
  expect(Math.abs(namespace.bytes - subpath.bytes)).toBeLessThan(1_000);
  expect(namespace.bundled.length).toBe(subpath.bundled.length);
};

// Budgets are measured values plus ~25% headroom. Raise them only for a
// change that is meant to grow every runtime.
const AWS_LAMBDA: Budget = {
  parsed: 1_000,
  bytes: 640_000,
  mapBytes: 6_600_000,
  services: ["Bootstrap", "Lambda", "S3"],
  // No HTTP server in an event Lambda, so nothing needs WebSocket upgrades.
  // (`ws` shipped here through the CLI's platform layer.)
  forbidden: [/[\\/]node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?ws[\\/]/],
};
const AWS_MICROVM: Budget = {
  parsed: 1_000,
  bytes: 640_000,
  mapBytes: 6_000_000,
  services: ["Bootstrap", "Lambda"],
};
const CLOUDFLARE_WORKER: Budget = {
  parsed: 1_500,
  bytes: 480_000,
  mapBytes: 5_800_000,
  services: ["KV", "Workers"],
};

layer(NodeServices.layer)("bundle canary", (it) => {
  it.effect(
    "AWS Lambda with an S3 binding",
    () =>
      Effect.gen(function* () {
        const namespace = yield* bundleLambda(fixture("aws-namespace.ts"));
        const subpath = yield* bundleLambda(fixture("aws-subpath.ts"));
        yield* report("import * as AWS", namespace, "aws");
        yield* report("@alchemy.run/aws/<Service>", subpath, "aws");
        expectWithinBudget(namespace, "aws", AWS_LAMBDA);
        expectWithinBudget(subpath, "aws", AWS_LAMBDA);
        expectSameCost(namespace, subpath);
      }),
    { tags: ["unit", "local"], timeout: 120_000 },
  );

  it.effect(
    "AWS MicroVM program on Node",
    () =>
      Effect.gen(function* () {
        const { stats, files } = yield* bundleMicrovm(fixture("aws-microvm.ts"));
        yield* report("MicroVM import * as AWS", stats, "aws");
        expectWithinBudget(stats, "aws", AWS_MICROVM);
        // Node maps minified stack traces back through the shipped map.
        expect(files.map((file) => file.path)).toContain("index.mjs.map");
        const dockerfile = buildMicrovmDockerfile(undefined, "node", 8080, { sourceMaps: true });
        expect(dockerfile).toContain("COPY *.map /app/");
        expect(dockerfile).toContain(
          'ENTRYPOINT ["node", "--enable-source-maps", "/app/index.mjs"]',
        );
      }),
    { tags: ["unit", "local"], timeout: 120_000 },
  );

  it.effect(
    "Cloudflare Worker with a KV binding",
    () =>
      Effect.gen(function* () {
        const namespace = yield* bundleWorker(fixture("cloudflare-namespace.ts"));
        const subpath = yield* bundleWorker(fixture("cloudflare-subpath.ts"));
        yield* report("import * as Cloudflare", namespace, "cloudflare");
        yield* report("@alchemy.run/cloudflare/<Service>", subpath, "cloudflare");
        expectWithinBudget(namespace, "cloudflare", CLOUDFLARE_WORKER);
        expectWithinBudget(subpath, "cloudflare", CLOUDFLARE_WORKER);
        expectSameCost(namespace, subpath);
      }),
    { tags: ["unit", "local"], timeout: 120_000 },
  );
});

// `it.live`: the readiness retry sleeps on the real clock, which `layer`'s
// `it.effect` replaces with a test clock.
it.live(
  "AWS MicroVM program boots minified and maps stack traces to source",
  () =>
    Effect.gen(function* () {
      const { files } = yield* bundleMicrovm(fixture("aws-microvm.ts"));
      const get = yield* bootMicrovm(files, 38_231);
      expect(yield* get("/hello")).toEqual({ path: "/hello" });
      const { stack } = (yield* get("/trace")) as { stack: string };
      // `keepNames` keeps the function name; the source map points at the
      // fixture, not the minified chunk.
      expect(stack).toMatch(/at canaryThrows \(.*aws-microvm\.ts:\d+:\d+\)/);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  { tags: ["unit", "local"], timeout: 120_000 },
);
