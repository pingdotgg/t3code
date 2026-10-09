/**
 * Cloudflare Vite plugin options for a vinext Worker. The injected
 * `@alchemy.run/cloudflare-runtime/vite` stack registers
 * `vite-plugin-cloudflare:alchemy` (vinext matches the prefix) and
 * no-ops any official `@cloudflare/vite-plugin` already in the config.
 */
import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import * as NodePath from "node:path";

export type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";

/** Set on the process that injects Alchemy's Cloudflare Vite plugin. */
export const ALCHEMY_CLOUDFLARE_VITE_INJECTED =
  "ALCHEMY_CLOUDFLARE_VITE_INJECTED";

/** vinext App Router: RSC worker + SSR child environment. */
export const VINEXT_VITE_ENVIRONMENTS = {
  entry: "rsc",
  children: ["ssr"],
} as const;

/** Official vinext Cloudflare worker entry. */
export const DEFAULT_WORKER_ENTRY = "worker/index.ts";

export interface VinextPluginOptionsInputs {
  readonly root: string;
  readonly main?: string | undefined;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: ReadonlyArray<string>;
  readonly viteEnvironments?: {
    readonly entry?: string;
    readonly children?: ReadonlyArray<string>;
  };
  readonly worker?: CloudflareVitePluginOptions["worker"];
  readonly context?: CloudflareVitePluginOptions["context"];
}

export const makeVinextPluginOptions = (
  inputs: VinextPluginOptionsInputs,
): CloudflareVitePluginOptions => {
  const main = inputs.main ?? DEFAULT_WORKER_ENTRY;
  return {
    main: NodePath.isAbsolute(main)
      ? main
      : NodePath.resolve(inputs.root, main),
    viteEnvironments: {
      entry: inputs.viteEnvironments?.entry ?? VINEXT_VITE_ENVIRONMENTS.entry,
      children: [
        ...(inputs.viteEnvironments?.children ??
          VINEXT_VITE_ENVIRONMENTS.children),
      ],
    },
    compatibilityDate: inputs.compatibilityDate,
    compatibilityFlags: [...inputs.compatibilityFlags],
    ...(inputs.worker !== undefined ? { worker: inputs.worker } : {}),
    ...(inputs.context !== undefined ? { context: inputs.context } : {}),
  };
};
