// Loader hook for published installs under Node.
//
// Beyond transpiling, the hook resolves the way tsx does: tsconfig `paths`,
// `.js` imports that mean `.ts` source, extensionless and directory imports,
// JSON without import attributes, and `require()` of TypeScript from `.cts`.
//
// Every alchemy Node process runs this file first: the `alchemy` CLI
// imports it before its entry (bin/cli.js), and the dev exec child, the
// local-provider sidecar and dev-server runners are started with `--import`
// of it. Alchemy itself and all of its dependencies run their built
// JavaScript; the hook exists so the USER's `.ts`/`.tsx` (the stack
// entrypoint and everything it imports from the project) transpiles through
// Oxc. Alchemy never relies on Node's built-in TypeScript support: it is
// strip-only (no parameter properties, enums, or TSX), and the transform
// flag that covered some of that was removed in Node 26.
//
// Anything under `node_modules` is left to Node, matching Node's own refusal
// to type-strip installed packages: a dependency is expected to ship
// JavaScript.
//
// Checkout runs use `register-dev-mode.js` instead, which installs the same
// loader without the filter (alchemy's own source is TypeScript there) and
// additionally resolves workspace packages onto their `src/`.
import { enableCompileCache, registerHooks } from "node:module";

// Node's module compile cache: V8 code cache persisted across processes,
// keyed by compiled source, so the loader's transformed TypeScript benefits
// too. Enabled before the loader is imported so the loader's own dependency
// graph (rolldown) is covered. Honours `NODE_COMPILE_CACHE` (directory) and
// `NODE_DISABLE_COMPILE_CACHE`; defaults to Node's per-user temp directory.
// The loader flushes it after lazy imports settle (see node-utils loader/hooks.ts).
enableCompileCache();

// distilled's lazy service stubs: with the `distilled-lazy` export condition
// a service module resolves to a stub that loads each operation on first
// use, so importing whole providers (as a stack does) costs a fraction of
// the heap. Opt-in: `alchemy --fast-distilled` (bin/cli.js turns the flag
// into `ALCHEMY_FAST_DISTILLED=1`, which child processes inherit), or the
// env var directly. Bundles never see the condition: a stub `require`s its
// full module at runtime, which no bundle contains. Installed before
// anything imports a provider.
if (process.env.ALCHEMY_FAST_DISTILLED === "1") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith("@distilled.cloud/")) return nextResolve(specifier, context);
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, "distilled-lazy"],
      });
    },
  });
}

const { registerOxc } = await import("@alchemy.run/node-utils/register-oxc");

registerOxc({
  filter: (path) => !/[\\/]node_modules[\\/]/.test(path),
});
