// @ts-check
// Node dev-mode hooks: run an alchemy checkout from source with no build.
//
// 1. A synchronous `resolve` hook (`module.registerHooks`) enables the
//    `bun` export condition for the monorepo's own packages (`alchemy`,
//    `@alchemy.run/*`, `@distilled.cloud/*`), whose exports map that
//    condition to `src/*.ts`. Under plain node the `import` condition
//    resolves built `lib/` output instead — requiring a `tsc -b` first,
//    and splitting the process across a src copy (the CLI) and a lib copy
//    (the user's stack, which imports `alchemy`) whenever lib is stale.
//    Packages without a `bun` condition (e.g. the published sigil) are
//    untouched — an enabled condition their exports never mention simply
//    doesn't match.
// 2. node-utils handles the actual `.ts`/`.tsx` loading with Rolldown's Oxc
//    transformer and source maps. Node's built-in TypeScript support does not
//    cover TSX and cannot apply each package's nearest tsconfig.
//
// Dev-only: the launcher (`bin/cli.js`) and the dev supervisor pass this
// via `--import` when spawning node in a checkout. Published installs run
// bundled `.js` and never load it; this file is excluded from the tarball.
// In a checkout, the source loader resolves from the workspace package.
import { registerHooks } from "node:module";

/** @param {string} specifier */
const isMonorepoPackage = (specifier) =>
  specifier === "alchemy" ||
  specifier.startsWith("alchemy/") ||
  specifier.startsWith("@alchemy.run/") ||
  specifier.startsWith("@distilled.cloud/");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isMonorepoPackage(specifier)) return nextResolve(specifier, context);
    return nextResolve(specifier, {
      ...context,
      conditions: ["bun", ...context.conditions],
    });
  },
});

// This import must happen after the condition hook is installed so a clean
// checkout resolves node-utils to source without requiring a prior build.
const { registerOxc } = await import("@alchemy.run/node-utils/register-oxc");

// Oxc discovers the nearest tsconfig for each transformed file. Alchemy's
// TSX therefore uses Alchemy's React settings while the user's config and its
// dependencies retain their own compiler settings.
registerOxc({ conditions: ["bun"] });
