import { isDeployTarget } from "../../core/index.ts";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import type * as ViteModule from "vite";
import { describe, expect, it } from "vitest";
import cloudflareTargetFactory, {
  makeWakuCloudflareTarget,
  makeWakuPluginOptions,
} from "../cloudflare.ts";
import { WAKU_SERVER_ENTRY_PATH } from "../index.ts";

const WAKU_DIR = "/project/node_modules/waku";

const context = {
  root: "/project",
  wakuDirectory: WAKU_DIR,
  phase: "build",
} as const;

const flatten = (
  plugins: ReadonlyArray<ViteModule.PluginOption>,
): Array<ViteModule.Plugin> =>
  (plugins as Array<unknown>)
    .flat(8)
    .filter(
      (plugin): plugin is ViteModule.Plugin =>
        typeof plugin === "object" && plugin !== null && "name" in plugin,
    );

describe("makeWakuPluginOptions", () => {
  it("defaults main to waku's rsc worker entry and pins the rsc/ssr topology", () => {
    const options = makeWakuPluginOptions({
      root: "/project",
      wakuDirectory: WAKU_DIR,
    });
    expect(options.main).toBe(NodePath.join(WAKU_DIR, WAKU_SERVER_ENTRY_PATH));
    expect(options.viteEnvironments).toEqual({
      entry: "rsc",
      children: ["ssr"],
    });
  });

  it("preserves user cloudflare options but overrides viteEnvironments", () => {
    const options = makeWakuPluginOptions({
      root: "/project",
      wakuDirectory: WAKU_DIR,
      pluginOptions: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        worker: { name: "fixtures-waku", bindings: [] },
        viteEnvironments: { entry: "ssr" },
      },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.compatibilityFlags).toEqual(["nodejs_als"]);
    expect(options.worker?.name).toBe("fixtures-waku");
    // The environment topology always wins: the worker must run in the rsc
    // environment.
    expect(options.main).toBe(NodePath.join(WAKU_DIR, WAKU_SERVER_ENTRY_PATH));
    expect(options.viteEnvironments).toEqual({
      entry: "rsc",
      children: ["ssr"],
    });
  });

  it("lets a user main (the user-entry seam) take precedence over waku's entry", () => {
    const absolute = makeWakuPluginOptions({
      root: "/project",
      wakuDirectory: WAKU_DIR,
      pluginOptions: { main: "/project/src/worker-entry.ts" },
    });
    expect(absolute.main).toBe("/project/src/worker-entry.ts");

    // A relative main resolves against the project root, not process.cwd().
    const relative = makeWakuPluginOptions({
      root: "/project",
      wakuDirectory: WAKU_DIR,
      pluginOptions: { main: "./src/worker-entry.ts" },
    });
    expect(relative.main).toBe(
      NodePath.resolve("/project", "src/worker-entry.ts"),
    );
    // The topology stays pinned even with a user main.
    expect(relative.viteEnvironments).toEqual({
      entry: "rsc",
      children: ["ssr"],
    });
  });

  it("defaults compatibilityFlags to nodejs_als (waku needs AsyncLocalStorage)", () => {
    expect(
      makeWakuPluginOptions({ root: "/project", wakuDirectory: WAKU_DIR })
        .compatibilityFlags,
    ).toEqual(["nodejs_als"]);
    expect(
      makeWakuPluginOptions({
        root: "/project",
        wakuDirectory: WAKU_DIR,
        pluginOptions: { compatibilityFlags: [] },
      }).compatibilityFlags,
    ).toEqual(["nodejs_als"]);
    expect(
      makeWakuPluginOptions({
        root: "/project",
        wakuDirectory: WAKU_DIR,
        pluginOptions: { compatibilityFlags: ["global_fetch_strictly_public"] },
      }).compatibilityFlags,
    ).toEqual(["global_fetch_strictly_public", "nodejs_als"]);
  });

  it("keeps user compatibilityFlags that already provide AsyncLocalStorage", () => {
    expect(
      makeWakuPluginOptions({
        root: "/project",
        wakuDirectory: WAKU_DIR,
        pluginOptions: { compatibilityFlags: ["nodejs_als"] },
      }).compatibilityFlags,
    ).toEqual(["nodejs_als"]);
    expect(
      makeWakuPluginOptions({
        root: "/project",
        wakuDirectory: WAKU_DIR,
        pluginOptions: { compatibilityFlags: ["nodejs_compat"] },
      }).compatibilityFlags,
    ).toEqual(["nodejs_compat"]);
    expect(
      makeWakuPluginOptions({
        root: "/project",
        wakuDirectory: WAKU_DIR,
        pluginOptions: { compatibilityFlags: ["nodejs_compat_v2"] },
      }).compatibilityFlags,
    ).toEqual(["nodejs_compat_v2"]);
  });
});

describe("makeWakuCloudflareTarget", () => {
  it("default-exports the target factory", () => {
    expect(cloudflareTargetFactory).toBe(makeWakuCloudflareTarget);
    expect(isDeployTarget(cloudflareTargetFactory({}))).toBe(true);
  });

  it("is a cloudflare DeployTarget carrying the config opaquely", () => {
    const config = { compatibilityDate: "2026-03-10" };
    const target = makeWakuCloudflareTarget(config);
    expect(target.platform).toBe("cloudflare");
    expect(target.config).toBe(config);
    expect(isDeployTarget(target)).toBe(true);
    // `config` must be an own property even when undefined — `isDeployTarget`
    // checks for its presence.
    expect(isDeployTarget(makeWakuCloudflareTarget())).toBe(true);
  });

  it("declares the workerd bundle conditions and cloudflare: externals", () => {
    const target = makeWakuCloudflareTarget();
    expect(target.bundle?.conditions).toEqual([
      "workerd",
      "worker",
      "module",
      "browser",
    ]);
    expect(target.bundle?.external).toEqual(["cloudflare:"]);
  });

  it("does not take over the framework build (no wholesale build hook)", () => {
    const target = makeWakuCloudflareTarget();
    expect(target.build).toBeUndefined();
    expect(target.finish).toBeUndefined();
  });

  it("resolves the adapter hook to this package's wrangler-free fork", () => {
    const target = makeWakuCloudflareTarget();
    const adapterPath = Effect.runSync(target.adapter(context));
    expect(NodePath.isAbsolute(adapterPath)).toBe(true);
    expect(adapterPath).toMatch(/adapter\.(ts|js)$/);
  });

  it("produces the cloudflare vite plugin with the pinned waku options", () => {
    const target = makeWakuCloudflareTarget({
      compatibilityDate: "2026-03-10",
    });
    const plugins = flatten(Effect.runSync(target.vitePlugins(context)));
    expect(plugins.length).toBeGreaterThan(0);
    expect(
      plugins.some((plugin) => plugin.name.startsWith("distilled-cloudflare")),
    ).toBe(true);
  });

  it("surfaces the config's main as the generic user-entry carriage", () => {
    expect(makeWakuCloudflareTarget().entry).toBeUndefined();
    expect(
      makeWakuCloudflareTarget({ compatibilityDate: "2026-03-10" }).entry,
    ).toBeUndefined();
    expect(
      makeWakuCloudflareTarget({ main: "./src/worker-entry.ts" }).entry,
    ).toEqual({
      main: "./src/worker-entry.ts",
    });
  });
});
