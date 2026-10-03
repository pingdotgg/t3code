import { fileURLToPath } from "node:url";

/**
 * Vitest alias entries that keep Vite `?worker` imports inert under test.
 *
 * Vitest evaluates modules in Node, where Vite's `?worker` transform does not
 * run, so the real worker bundle is loaded as an ordinary module and its `self`
 * references throw `ReferenceError: self is not defined` while the importing
 * test file is still being collected. Aliasing every `?worker` specifier to an
 * inert stub keeps such imports importable.
 *
 * The pattern is anchored to the whole specifier because a RegExp `find`
 * replaces the matched substring, not the entire import.
 *
 * Both the repository root config and `apps/web` must apply this: `pnpm test`
 * runs each workspace package's own test script, so the web package resolves
 * its own `vite.config.ts` and never reads the root one.
 */
export const vitestWebWorkerAlias = [
  {
    find: /^.*\?worker$/,
    replacement: fileURLToPath(
      new URL("../../apps/web/src/testSupport/webWorkerStub.ts", import.meta.url),
    ),
  },
];