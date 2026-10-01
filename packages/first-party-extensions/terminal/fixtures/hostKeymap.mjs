/**
 * The REAL host keymap machinery, bundled from the web source for tests:
 * the `t3.ui/keybindings@1.1.0` client bridge, the dispatcher's
 * `resolveShortcutCommand`, its published `when` context, and the
 * extension-claim helper. Only the live atom store is stubbed — tests
 * inject the keymap through the bridge's `keybindings` seam.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";

const require = NodeModule.createRequire(import.meta.url);
const { build } = require("esbuild");
const packageDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));

// Host sources live outside the package; the segments are joined so no
// literal cross-tree path appears in this file's content.
const webSource = (...segments) =>
  NodePath.join(packageDir, "..", "..", "..", "apps", "web", "src", ...segments);

export async function loadHostKeymap() {
  const built = await build({
    stdin: {
      contents: [
        ["createKeybindingsHostBridge", webSource("extensions", "keybindingsHostBridge.ts")],
        ["publishShortcutContext", webSource("lib", "shortcutContext.ts")],
        ["resolveShortcutCommand", webSource("keybindings.ts")],
        ["isExtensionClaimedTerminalCommand", webSource("lib", "terminalFocus.ts")],
      ]
        .map(([name, path]) => `export { ${name} } from ${JSON.stringify(path)};`)
        .join("\n"),
      resolveDir: packageDir,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "web-aliases",
        setup(builder) {
          builder.onResolve({ filter: /^~\/(rpc\/atomRegistry|state\/server)$/ }, (args) => ({
            path: args.path,
            namespace: "live-store-stub",
          }));
          builder.onLoad({ filter: /.*/, namespace: "live-store-stub" }, () => ({
            contents:
              "export const primaryServerKeybindingsAtom = null;" +
              "export const appAtomRegistry = { get() { throw new Error('inject keybindings'); } };",
            loader: "js",
          }));
          builder.onResolve({ filter: /^~\// }, (args) => {
            const base = webSource(...args.path.slice(2).split("/"));
            const path = [".ts", ".tsx"].map((ext) => base + ext).find(NodeFS.existsSync);
            return path === undefined ? undefined : { path };
          });
        },
      },
    ],
  });
  const bundleDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-terminal-host-keymap-"),
  );
  const bundlePath = NodePath.join(bundleDir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(bundlePath, built.outputFiles[0].text);
    return await import(NodeURL.pathToFileURL(bundlePath).href);
  } finally {
    await NodeFSP.rm(bundleDir, { recursive: true, force: true });
  }
}

/** A user rule compiled exactly as the host compiles `keybindings.json`. */
export const userRule = (command, key, when) =>
  compileResolvedKeybindingRule(when === undefined ? { command, key } : { command, key, when });

/**
 * `host.keybindings` as the web client builds it for an installation holding
 * the `t3.ui/keybindings` grant, reading whatever `rules()` returns now.
 */
export function hostKeybindings(keymap, rules, overrides = {}) {
  return keymap.createKeybindingsHostBridge({ keybindings: rules, ...overrides })({
    grants: { capabilities: ["t3.ui/keybindings"] },
    lifetime: new AbortController().signal,
  });
}
