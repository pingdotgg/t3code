// Loader hook for published installs under Node.
//
// Beyond transpiling, the hook resolves the way tsx does: tsconfig `paths`,
// `.js` imports that mean `.ts` source, extensionless and directory imports,
// JSON without import attributes, and `require()` of TypeScript from `.cts`.
//
// Every alchemy Node process — the `alchemy` CLI, the dev exec child, the
// local-provider sidecar, dev-server runners — is started with `--import`
// of this file. Alchemy itself and all of its dependencies run their built
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
import { registerOxc } from "@alchemy.run/node-utils/register-oxc";

registerOxc({
  filter: (path) => !/[\\/]node_modules[\\/]/.test(path),
});
