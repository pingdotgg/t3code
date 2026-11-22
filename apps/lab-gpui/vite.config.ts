// Conn desktop lab: the web app's own Vite config plus stand-ins, served from this package.
// The connection driver is the fake environment (src/labDriver.ts). `vp run dev` serves
// index.html on 127.0.0.1:5800; `vp run build` writes a bundle that loads fast over WireGuard.
import { fileURLToPath } from "node:url";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin, type PluginOption, type UserConfig } from "vite-plus";
import base from "../web/vite.config";

const lab = fileURLToPath(new URL("./", import.meta.url));
const web = fileURLToPath(new URL("../web/", import.meta.url));
const src = `${lab}src/`;
const webSrc = `${web}src/`;
const pr = `${src}pr/`;
// Real module → lab stand-in. The driver is the fake server; the rest give the PR panel a real
// PR's fixture (src/pr) instead of the source-control RPCs.
const STUBBED: Record<string, string> = {
  [fileURLToPath(
    new URL("../../packages/client-runtime/src/connection/driver.ts", import.meta.url),
  )]: `${src}labDriver.ts`,
  // The icon switch (src/icons): connIcon asks this module for a replacement glyph.
  [`${webSrc}icons/iconOverride.ts`]: `${src}icons/iconOverride.tsx`,
  [`${webSrc}state/session.ts`]: `${pr}session.ts`,
  [`${webSrc}state/sourceControlActions.ts`]: `${pr}sourceControlActions.ts`,
  [`${webSrc}state/use-atom-command.ts`]: `${pr}use-atom-command.ts`,
  [`${webSrc}state/usePullRequestStack.ts`]: `${pr}usePullRequestStack.ts`,
  [`${webSrc}state/pullRequests.ts`]: `${pr}pullRequests.ts`,
  [`${webSrc}components/pullRequest/usePullRequestDetail.ts`]: `${pr}usePullRequestDetail.ts`,
};

function labStubs(): Plugin {
  return {
    name: "conn-lab-driver",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const stub = resolved ? STUBBED[resolved.id.split("?")[0]!] : undefined;
      // A stand-in reaches the real module it wraps; every other importer gets the stand-in.
      if (!stub || importer.split("?")[0] === stub) return null;
      return stub;
    },
    // Tasks reads Conn's own Orbit fixtures, which only dev builds allow; the lab bundle is a
    // production build, so this one module keeps its dev path.
    transform(code, id) {
      if (!id.split("?")[0]!.endsWith("/src/orbit/tasks/orbitTasksClient.ts")) return null;
      return code.replaceAll("import.meta.env.DEV", "true");
    },
  };
}

const isRouterPlugin = (plugin: PluginOption) =>
  !!plugin &&
  typeof plugin === "object" &&
  "name" in plugin &&
  /^tanstack(-router)?:/.test(String(plugin.name));

// `vp run` reads `run` from this file without executing it (as in apps/web), so building the task
// graph never loads the app's plugins: CI jobs that install only part of the workspace need that.
// Keep `run` a literal here, after the spread.
export default defineConfig(async (env) => {
  // The app's test projects stay with the app.
  const { test: _test, ...config } = (
    typeof base === "function" ? await base(env) : base
  ) as UserConfig;
  return {
    ...config,
    run: {
      tasks: {
        // As in apps/web: a local tsbuildinfo is leftover build state, not a typecheck input.
        typecheck: {
          command: "effect-tsgo tsrs --noEmit",
          cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
        },
      },
    },
    root: lab,
    // The app's public assets and env files stay in apps/web.
    publicDir: `${web}public`,
    envDir: web,
    plugins: [
      labStubs(),
      // The router plugin reads routes from the Vite root, which is now this package.
      tanstackRouter({
        autoCodeSplitting: true,
        routesDirectory: `${webSrc}routes`,
        generatedRouteTree: `${webSrc}routeTree.gen.ts`,
      }),
      ...(config.plugins ?? []).flat(3).filter((plugin) => !isRouterPlugin(plugin)),
    ],
    optimizeDeps: {
      ...config.optimizeDeps,
      // The app's pre-bundled dependencies resolve from apps/web, not from this package.
      include: (config.optimizeDeps?.include ?? []).map((id) => `@t3tools/web > ${id}`),
      entries: ["index.html"],
    },
    server: {
      ...config.server,
      host: process.env.HOST?.trim() || "127.0.0.1",
      port: Number(process.env.PORT ?? 5800),
      strictPort: true,
      warmup: { clientFiles: ["./src/main.tsx"] },
    },
    build: {
      ...config.build,
      outDir: process.env.LAB_OUT_DIR ?? "dist",
      emptyOutDir: true,
      manifest: false,
    },
  } satisfies UserConfig;
});
