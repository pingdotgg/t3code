import type { OpenShellSharedCacheSettings, OpenShellWorkerClass } from "@t3tools/contracts";

/**
 * What a worker carries to be a real workspace (spec section 9): config homes
 * and project rules travel in, the MCP surface is referenced, credentials never.
 */
export type BaggageDisposition = "copy" | "reference" | "skip";

export interface BaggageItem {
  readonly name: string;
  readonly disposition: BaggageDisposition;
  /** Where it goes inside the sandbox, or the address it points at. */
  readonly target: string;
  readonly reason: string;
}

export interface WorkerBaggage {
  readonly items: ReadonlyArray<BaggageItem>;
  /** Environment variables the sandbox needs, without any secret value. */
  readonly env: Readonly<Record<string, string>>;
  /** Read-only mounts from the shared RWX volume, when one is configured. */
  readonly mounts: ReadonlyArray<{
    readonly source: string;
    readonly target: string;
    readonly readOnly: boolean;
  }>;
  readonly warnings: ReadonlyArray<string>;
}

export interface WorkerBaggageInput {
  readonly workerClass: OpenShellWorkerClass;
  /** The managing instance's MCP endpoint; the worker calls it instead of copying tools. */
  readonly mcpEndpoint: string | undefined;
  readonly sharedCache: OpenShellSharedCacheSettings | undefined;
  /** Provider config homes present here, by name, e.g. `.claude` and `.codex`. */
  readonly providerHomes: ReadonlyArray<string>;
  readonly agentInstructions: ReadonlyArray<string>;
}

/**
 * Package-manager cache directories that may live on the shared volume. Each is
 * derived state: losing one costs a re-download, never a fact (spec section 8).
 */
export const SHARED_CACHE_LANES: ReadonlyArray<{
  readonly name: string;
  readonly env: string;
  readonly path: string;
}> = [
  { name: "pnpm", env: "PNPM_STORE_DIR", path: "pnpm-store" },
  { name: "npm", env: "npm_config_cache", path: "npm-cache" },
  { name: "yarn", env: "YARN_CACHE_FOLDER", path: "yarn-cache" },
  { name: "cargo", env: "CARGO_HOME", path: "cargo" },
  { name: "go", env: "GOMODCACHE", path: "go-mod" },
  { name: "pip", env: "PIP_CACHE_DIR", path: "pip" },
];

/** Never copied into a sandbox: these are the keys the gateway injects instead. */
const CREDENTIAL_NAMES = [
  "credentials.json",
  "auth.json",
  ".netrc",
  "hosts.yml",
  ".npmrc",
  ".pgpass",
];

/**
 * The sandbox-side path of the shared RO git mirrors (spec sections 8.4 and
 * 10.1). Baggage mounts and the spawn seed env both derive from this one
 * place, so the mount and the seed can never drift apart.
 */
export const mirrorGitPath = (cache: OpenShellSharedCacheSettings): string | undefined =>
  cache.enabled && cache.mode !== "none" && cache.pvcNames?.mirrors !== undefined
    ? `${cache.mountPath}/git-mirrors`
    : undefined;

export const T3_SEED_REMOTE_ENV = "T3_SEED_REMOTE";
export const T3_SEED_REF_ENV = "T3_SEED_REF";

/**
 * Spawn-seed environment (spec section 10): `T3_SEED_REMOTE` names the shared
 * mirror — `<name>#<ref>` picks one mirror repo, a bare ref seeds from the
 * mirror root — and `T3_SEED_REF` the ref to check out. Undefined when no
 * RWX mirror is configured: the caller then clones from the remote and says so.
 */
export const seedEnvironment = (
  cache: OpenShellSharedCacheSettings | undefined,
  seedFrom: string,
): Record<string, string> | undefined => {
  if (cache === undefined || !cache.enabled || cache.mode !== "rwx-pvc") return undefined;
  const mirrorPath = mirrorGitPath(cache);
  if (mirrorPath === undefined) return undefined;
  const separator = seedFrom.indexOf("#");
  const mirror = separator === -1 ? "" : seedFrom.slice(0, separator);
  const ref = separator === -1 ? seedFrom : seedFrom.slice(separator + 1);
  return {
    [T3_SEED_REMOTE_ENV]: mirror === "" ? mirrorPath : `${mirrorPath}/${mirror}`,
    [T3_SEED_REF_ENV]: ref,
  };
};

export const buildWorkerBaggage = (input: WorkerBaggageInput): WorkerBaggage => {
  const items: BaggageItem[] = [];
  const env: Record<string, string> = {};
  const mounts: Array<{ source: string; target: string; readOnly: boolean }> = [];
  const warnings: string[] = [];

  for (const home of input.providerHomes) {
    items.push({
      name: `provider-home:${home}`,
      disposition: "copy",
      target: `/root/${home}`,
      reason: "The provider reads its own config home; skills and prompts live there.",
    });
    items.push({
      name: `provider-credentials:${home}`,
      disposition: "skip",
      target: `/root/${home}/{${CREDENTIAL_NAMES.join(",")}}`,
      reason: "Model and git credentials come from gateway providers, never from the image.",
    });
  }
  for (const instruction of input.agentInstructions) {
    items.push({
      name: `instructions:${instruction}`,
      disposition: "copy",
      target: `/workspace/${instruction}`,
      reason: "A worker that does not know the project rules is not the same agent.",
    });
  }
  if (input.mcpEndpoint === undefined) {
    warnings.push(
      "No MCP endpoint is known yet, so the worker starts without the managing instance's tools.",
    );
  } else {
    items.push({
      name: "mcp:t3",
      disposition: "reference",
      target: input.mcpEndpoint,
      reason: "The tool surface stays on the managing instance; the worker only needs its address.",
    });
    env["T3_MCP_ENDPOINT"] = input.mcpEndpoint;
  }
  env["T3_WORKER_CLASS"] = input.workerClass;

  const cache = input.sharedCache;
  if (cache !== undefined && cache.enabled && cache.mode !== "none") {
    const cachePath = cache.pvcNames?.cache ?? "cache";
    const mirrorPath = cache.pvcNames?.mirrors;
    for (const lane of SHARED_CACHE_LANES) {
      const target = `${cache.mountPath}/${lane.path}`;
      mounts.push({ source: `${cachePath}/${lane.path}`, target, readOnly: false });
      env[lane.env] = target;
    }
    const mirrorTarget = mirrorGitPath(cache);
    if (mirrorTarget !== undefined) {
      mounts.push({
        source: `${mirrorPath}/git`,
        target: mirrorTarget,
        readOnly: true,
      });
    } else {
      warnings.push(
        "No shared git mirror is configured, so each worker clones from the remote on cold start.",
      );
    }
  } else if (cache !== undefined && cache.enabled) {
    warnings.push("The shared cache is enabled but its mode is none, so nothing is mounted.");
  }

  return { items, env, mounts, warnings };
};

/**
 * The template a worker fleet is created from: image, cache mounts and the
 * non-secret environment the baggage resolves to (spec section 9.1).
 */
export const templateSpecFromBaggage = (input: {
  readonly name: string;
  readonly image: string;
  readonly baggage: WorkerBaggage;
  readonly cpu?: string;
  readonly memory?: string;
  readonly gpu?: number;
}): {
  readonly name: string;
  readonly image: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mounts: ReadonlyArray<{
    readonly source: string;
    readonly target: string;
    readonly readOnly: boolean;
  }>;
  readonly role: "worker";
} => ({
  name: input.name,
  image: input.image,
  environment: input.baggage.env,
  mounts: input.baggage.mounts,
  role: "worker",
});
