#!/usr/bin/env node
/**
 * Copies the Ghostty files this extension declares as package assets (see
 * `assets` in extension.tsx) from @t3tools/ghostty-terminal into ./assets.
 *
 * `t3-extension build` packs only regular files inside the source directory,
 * and the bytes live once, in the ghostty-terminal package, so ./assets is a
 * gitignored staging copy. `prepare` stages it on install and `build` again
 * before packing, so a rebuilt bundle always carries the package's bytes.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const GHOSTTY_ASSETS = [
  "ghostty-vt.wasm",
  "ghostty-write-pty.wasm",
  "SymbolsNerdFontMono-Regular.woff2",
  "SymbolsNerdFontMono-LICENSE.txt",
  "libghostty-vt-LICENSE.txt",
  "libghostty-vt-VERSION.txt",
];

const target = NodeURL.fileURLToPath(new URL("./assets/", import.meta.url));
NodeFS.mkdirSync(target, { recursive: true });
for (const name of GHOSTTY_ASSETS) {
  const source = NodeURL.fileURLToPath(
    import.meta.resolve(`@t3tools/ghostty-terminal/assets/${name}`),
  );
  NodeFS.copyFileSync(source, NodePath.join(target, name));
}
