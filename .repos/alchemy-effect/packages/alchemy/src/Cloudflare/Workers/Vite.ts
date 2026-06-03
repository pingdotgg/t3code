import cloudflare, {
  type CloudflareVitePluginOptions,
} from "@distilled.cloud/cloudflare-vite-plugin";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as vite from "vite";

export const viteDev = (
  rootDir: string = process.cwd(),
  env: Record<string, unknown>,
  pluginOptions: CloudflareVitePluginOptions,
  serverOptions: vite.ServerOptions,
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const vite = await loadVite(rootDir);
      const devServer = await vite.createServer({
        root: rootDir,
        define: getDefine(env),
        plugins: [cloudflare(pluginOptions)],
        server: serverOptions,
      });
      await devServer.listen();
      return devServer;
    }),
    (devServer) =>
      Effect.promise(async () => {
        await devServer.close();
      }),
  );

export const viteBuild = (
  rootDir: string = process.cwd(),
  env: Record<string, unknown>,
  pluginOptions: CloudflareVitePluginOptions,
) =>
  Effect.promise(async () => {
    let serverBundle: vite.Rolldown.OutputBundle | undefined;
    let assetsDirectory: string | undefined;
    const vite = await loadVite(rootDir);
    const builder = await vite.createBuilder(
      {
        root: rootDir,
        define: getDefine(env),
        plugins: [
          cloudflare(pluginOptions),
          {
            name: "output:ssr",
            applyToEnvironment(environment) {
              return environment.name === "ssr";
            },
            generateBundle(_outputOptions, bundle) {
              serverBundle = bundle;
            },
          },
          {
            name: "output:client",
            applyToEnvironment(environment) {
              return environment.name === "client";
            },
            generateBundle(outputOptions) {
              assetsDirectory = outputOptions.dir;
            },
          },
        ],
      },
      // This is the `useLegacyBuilder` option. The Vite CLI implementation uses `null` here.
      // Originally we used `undefined` here, but this caused the static site build to fail.
      // https://github.com/vitejs/vite/blob/a07a4bd052ac75f916391c999c408ad5f2867e61/packages/vite/src/node/cli.ts#L367
      null,
    );
    await builder.buildApp();
    return {
      serverBundle,
      assetsDirectory,
    };
  });

// Emulate `vite build` env semantics for `props.env`: only
// keys with Vite's default `VITE_` prefix are inlined into
// the bundle as `import.meta.env.*`. `Redacted` values are
// unwrapped — by prefixing with `VITE_` the user is opting
// them into the public bundle.
const getDefine = (env: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, raw]) => {
      if (!key.startsWith("VITE_")) return [];
      const value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
      return [[`import.meta.env.${key}`, JSON.stringify(value)] as const];
    }),
  );

type ViteModule = typeof import("vite");

/**
 * Dynamically load Vite from the project root. Falls back to the bundled
 * copy if the project doesn't have its own Vite installation.
 */
async function loadVite(
  projectRoot: string = process.cwd(),
): Promise<ViteModule> {
  try {
    const require = createRequire(path.join(projectRoot, "package.json"));
    const vitePath = require.resolve("vite");
    // On Windows, absolute paths must be file:// URLs for ESM import().
    const viteUrl = pathToFileURL(vitePath);
    return await import(/* @vite-ignore */ viteUrl.href);
  } catch {
    // Fallback: try to import vite from the global node_modules (works for non-linked installs)
    // The fallback is a bare specifier and works as-is.
    return await import("vite");
  }
}
