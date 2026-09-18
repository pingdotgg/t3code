import { isRegisterHooksSupported } from "@/Util/Node.ts";

/**
 * The real node binary tests spawn, and ITS version — not bun's emulated
 * `process.versions.node`, which is what the version gates would
 * consult by default. Gating on the wrong runtime made the node-launcher
 * tests run (and fail with zero diagnostics) on machines whose PATH node
 * is older than the version bun reports.
 */
export const nodePath = typeof Bun !== "undefined" ? Bun.which("node") : null;

export const nodeVersion: string | null = (() => {
  if (nodePath === null) return null;
  try {
    const probe = Bun.spawnSync([nodePath, "-p", "process.versions.node"]);
    const version = probe.stdout.toString().trim();
    return probe.exitCode === 0 && version.length > 0 ? version : null;
  } catch {
    return null;
  }
})();

/**
 * Whether the spawned node can run alchemy's dev-mode source path: hooks
 * capable implies `.ts` capable (transform flag below v26, native from v26).
 */
export const nodeSupportsDevMode =
  nodeVersion !== null && isRegisterHooksSupported(nodeVersion);
