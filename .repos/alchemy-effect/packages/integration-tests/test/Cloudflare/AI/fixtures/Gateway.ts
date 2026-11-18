import * as Cloudflare from "@alchemy.run/cloudflare";

export const Gateway = Cloudflare.AI.Gateway("Gateway", {
  cacheTtl: 60,
  collectLogs: true,
});
