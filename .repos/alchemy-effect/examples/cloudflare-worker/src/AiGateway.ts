import * as Cloudflare from "alchemy/Cloudflare";

export const Gateway = Cloudflare.AiGateway("Gateway", {
  cacheTtl: 60,
  collectLogs: true,
});
