import * as Cloudflare from "alchemy/Cloudflare";

export const Gateway = Cloudflare.AI.Gateway("Gateway", {
  cacheTtl: 60,
  collectLogs: true,
});
