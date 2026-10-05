// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Programmatic @opennextjs/cloudflare build runner — NO wrangler binary, NO
// wrangler.json. Executed as a disposable child process (see Build.ts): the
// upstream pipeline mutates cwd-coupled module state, spawns `next build`, and
// can process.exit(1), so it must never run inside the harness process.
//
// Instead of importing `dist/cli/commands/utils/utils.js` (which imports
// `unstable_readConfig` from "wrangler" at module scope), the two thin
// `compileConfig` / `getNormalizedOptions` wrappers are vendored here (~15
// lines) over `@opennextjs/aws` exports so that NOTHING on this path ever
// imports wrangler code. (`ensureNextjsVersionSupported` still imports
// `wrangler/package.json` — a JSON version read satisfied by the inert
// `wrangler-stub` package this integration ships.)
//
// Usage: node runner.mjs '<json>' where json is Build.ts's RunnerConfig:
//   { appDir, configPath, compatibilityDate, skipNextBuild, minify, debug,
//     buildCommand }
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runnerConfig = JSON.parse(process.argv[2] ?? "{}");
const appDir = path.resolve(runnerConfig.appDir ?? process.cwd());
process.chdir(appDir); // upstream reads process.cwd() at module scope

// Resolve the framework integration from the application's dependency tree.
const require = createRequire(path.join(appDir, "package.json"));
// The exports map doesn't expose "./package.json"; resolve the "." entry
// (dist/api/index.js) and walk up to the package root.
const cfApiIndex = require.resolve("@opennextjs/cloudflare");
const cfRoot = path.resolve(path.dirname(cfApiIndex), "..", "..");
const cfRequire = createRequire(path.join(cfRoot, "package.json"));

/** Import a file from the @opennextjs/cloudflare dist (bypasses the exports map). */
const importCf = (p) => import(pathToFileURL(path.join(cfRoot, p)).href);
/** Import a subpath of @opennextjs/aws resolved from the cloudflare package. */
const importAws = (p) =>
  import(pathToFileURL(cfRequire.resolve(`@opennextjs/aws/${p}`)).href);

const { compileOpenNextConfig } = await importAws("build/compileConfig.js");
const { normalizeOptions } = await importAws("build/helper.js");
const { default: logger } = await importAws("logger.js");
const { ensureCloudflareConfig } = await importCf(
  "dist/cli/build/utils/ensure-cf-config.js",
);
const { build } = await importCf("dist/cli/build/build.js");

const configPath = runnerConfig.configPath ?? runnerConfig.generatedConfigPath;
if (runnerConfig.generatedConfigPath) {
  const resolveOverride = (name) =>
    JSON.stringify(require.resolve(`@opennextjs/cloudflare/overrides/${name}`));
  const writable = runnerConfig.cache === "kv";
  fs.writeFileSync(
    configPath,
    `
import { defineCloudflareConfig } from ${JSON.stringify(cfApiIndex)};
import incrementalCache from ${resolveOverride(writable ? "incremental-cache/kv-incremental-cache" : "incremental-cache/static-assets-incremental-cache")};
${writable ? `import queue from ${resolveOverride("queue/do-queue")};\nimport tagCache from ${resolveOverride("tag-cache/kv-next-tag-cache")};` : ""}
export default defineCloudflareConfig({ incrementalCache${writable ? ", queue, tagCache" : ""} });
`,
  );
}
const { config, buildDir } = await compileOpenNextConfig(configPath, {
  compileEdge: true,
});
ensureCloudflareConfig(config);
config.buildCommand =
  runnerConfig.buildCommand ?? config.buildCommand ?? "npx next build";

const openNextDistDir = path.dirname(
  cfRequire.resolve("@opennextjs/aws/index.js"),
);
const options = normalizeOptions(config, openNextDistDir, buildDir);
logger.setLevel(runnerConfig.debug ? "debug" : "info");

// Only these two Wrangler fields are read by the OpenNext build pipeline.
const wranglerConfig = {
  compatibility_date: runnerConfig.compatibilityDate,
  assets: { run_worker_first: true },
};
const projectOptions = {
  sourceDir: appDir,
  skipNextBuild: !!runnerConfig.skipNextBuild,
  skipWranglerConfigCheck: true,
  minify: !!runnerConfig.minify,
};
await build(options, config, projectOptions, wranglerConfig, false);
console.log(
  "[@alchemy.run/frontend-frameworks/nextjs] OpenNext build finished OK",
);
fs.writeFileSync(
  runnerConfig.outputPath,
  JSON.stringify({
    openNextDirectory: options.outputDir,
    appBuildOutputPath: options.appBuildOutputPath,
  }),
);
