// @effect-diagnostics nodeBuiltinImport:off - setup-script bootstrap, runs before any Effect runtime exists.
/**
 * Pre-warms Vite's dependency-optimizer cache (`node_modules/.vite/deps`) so
 * the first `vp run dev` in a fresh worktree doesn't stall the initial page
 * load on a full optimize pass. Run by the t3.json worktree setup script;
 * safe to re-run — a valid cache makes this a fast no-op.
 *
 * The cache cannot be shared between worktrees: Vite's config hash includes
 * the absolute project root, so each worktree must warm its own.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { optimizeDeps, resolveConfig } from "vite";

const webRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

// logLevel "error" silences the "manually calling optimizeDeps is deprecated"
// warning — deliberate here: warming ahead of the server is the whole point.
const config = await resolveConfig({ root: webRoot, logLevel: "error" }, "serve");
await optimizeDeps(config);
console.log("[warm-dep-cache] web dependency cache is warm");
