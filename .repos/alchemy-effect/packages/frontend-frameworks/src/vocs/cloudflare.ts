import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import { makeWakuCloudflareTarget } from "../waku/cloudflare.ts";
import type { VocsTarget } from "./Target.ts";

export type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";

/** Cloudflare configuration for the Vocs runtime. */
export interface VocsCloudflareConfig {
  readonly worker?: CloudflareVitePluginOptions | undefined;
}

/**
 * Build the Cloudflare target for Vocs.
 *
 * The adapter and RSC environment topology are the established Waku target;
 * Vocs adds the stronger `nodejs_compat` requirement needed by its server
 * bundle (`node:fs` and related guarded imports).
 */
export const target = (
  config: VocsCloudflareConfig = {},
): VocsTarget<CloudflareVitePluginOptions | undefined> => {
  const worker = config.worker;
  const flags = worker?.compatibilityFlags;
  return makeWakuCloudflareTarget({
    ...worker,
    compatibilityFlags: flags?.includes("nodejs_compat")
      ? flags
      : [...(flags ?? []), "nodejs_compat"],
  });
};

export default target;
