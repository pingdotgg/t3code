import { type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "bun install --filter '@t3tools/scripts' --filter '@t3tools/marketing'",
  buildCommand: "bun ../../scripts/mirror-provider-compatibility-map.ts && astro build",
};
