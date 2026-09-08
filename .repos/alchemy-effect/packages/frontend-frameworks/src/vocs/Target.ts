import { isDeployTarget, type DeployTargetInput } from "../core/index.ts";
import type { WakuTarget } from "../waku/Waku.ts";

/**
 * A deploy target capable of hosting Vocs' Waku/RSC runtime.
 *
 * Vocs uses Waku's adapter and environment topology, so its target contract
 * deliberately extends the existing Waku target hooks. The distinct type and
 * module boundary keep Vocs target selection independent from the Waku
 * framework integration.
 */
export interface VocsTarget<Config = unknown> extends WakuTarget<Config> {}

/** Target-scoped configuration carried by the shared E2E harness. */
export interface VocsHarnessTargetOptions {
  readonly name?: string | undefined;
  readonly cloudflare?: { readonly worker?: unknown } | undefined;
}

export type VocsTargetOption =
  | DeployTargetInput<VocsTarget, unknown>
  | VocsHarnessTargetOptions;

/** The default target is Vocs' own Cloudflare target module. */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vocs/cloudflare";

const isDeployTargetInput = (
  value: unknown,
): value is DeployTargetInput<VocsTarget, unknown> =>
  typeof value === "string" ||
  typeof value === "function" ||
  isDeployTarget(value);

export interface VocsTargetInputSelection {
  readonly input: DeployTargetInput<VocsTarget, unknown>;
  readonly config: unknown;
}

/** Normalize direct target inputs and the E2E harness's target carriage. */
export const selectVocsTargetInput = (options?: {
  readonly target?: VocsTargetOption | undefined;
  readonly vite?: unknown;
}): VocsTargetInputSelection => {
  const raw = options?.target;
  if (raw !== undefined && isDeployTargetInput(raw)) {
    return { input: raw, config: options?.vite };
  }
  return {
    input: DEFAULT_TARGET_SPECIFIER,
    config: raw?.cloudflare?.worker ?? options?.vite,
  };
};

export const isVocsTarget = (value: unknown): value is VocsTarget =>
  isDeployTarget(value) &&
  typeof (value as { adapter?: unknown }).adapter === "function" &&
  typeof (value as { vitePlugins?: unknown }).vitePlugins === "function";
