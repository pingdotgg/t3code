import type { RuntimeMode } from "@t3tools/contracts";

/**
 * Runtime-mode → sandbox policy translation for work on fleet workers (spec
 * section 5.2, lanes 4 and 7). The value is valid at the
 * `RuntimePolicyV2Override.sandboxPolicy` seam (`layerWithOverride` in
 * apps/server) and the driver also applies it as gateway per-sandbox policy.
 */

/** The worker's checkout root: the K8s driver mounts the workspace PVC at /sandbox (lane 1). */
export const WORKER_WORKSPACE_ROOT = "/sandbox";

/** Package registries allowed for `auto-accept-edits` workers (spec section 5.2). */
export const REGISTRY_ALLOWLIST_DOMAINS: ReadonlyArray<string> = [
  "registry.npmjs.org",
  "npm.pkg.github.com",
];

/** Broader egress added for `auto` workers (git remote reachability). */
export const AUTO_EGRESS_EXTRA_DOMAINS: ReadonlyArray<string> = [
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
];

export type OpenShellNetworkPolicyMode = "default-deny" | "allowlist" | "permissive";

export interface OpenShellWorkerSandboxPolicy {
  readonly type: "readOnly" | "workspaceWrite" | "dangerFullAccess";
  readonly writableRoots?: ReadonlyArray<string>;
  readonly network: {
    readonly mode: OpenShellNetworkPolicyMode;
    readonly allowedDomains: ReadonlyArray<string>;
  };
}

export interface SandboxPolicyOptions {
  /** Writable root for workspace-write modes; defaults to WORKER_WORKSPACE_ROOT. */
  readonly workspaceRoot?: string;
  /** Replaces the registry allowlist for allowlist modes. */
  readonly registryDomains?: ReadonlyArray<string>;
}

/**
 * Translates one runtime mode; there is deliberately no default argument. The
 * driver applies `approval-required` when a caller passes no mode.
 * OPEN-QUESTION (spec section 5.2): whether spawn should inherit the
 * delegating thread's mode is undecided; until then the strictest mapping wins.
 */
export const sandboxPolicyForRuntimeMode = (
  mode: RuntimeMode,
  options: SandboxPolicyOptions = {},
): OpenShellWorkerSandboxPolicy => {
  const workspaceRoot = options.workspaceRoot ?? WORKER_WORKSPACE_ROOT;
  const registries = options.registryDomains ?? REGISTRY_ALLOWLIST_DOMAINS;
  switch (mode) {
    case "approval-required":
      return { type: "readOnly", network: { mode: "default-deny", allowedDomains: [] } };
    case "auto-accept-edits":
      return {
        type: "workspaceWrite",
        writableRoots: [workspaceRoot],
        network: { mode: "allowlist", allowedDomains: [...registries] },
      };
    case "auto":
      return {
        type: "workspaceWrite",
        writableRoots: [workspaceRoot],
        network: {
          mode: "allowlist",
          allowedDomains: [...registries, ...AUTO_EGRESS_EXTRA_DOMAINS],
        },
      };
    case "full-access":
      return { type: "dangerFullAccess", network: { mode: "permissive", allowedDomains: [] } };
  }
};
