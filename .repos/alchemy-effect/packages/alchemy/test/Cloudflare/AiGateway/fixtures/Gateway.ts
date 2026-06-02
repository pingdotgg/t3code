import * as Cloudflare from "@/Cloudflare/index.ts";

export const Gateway = Cloudflare.AiGateway("Gateway", {
  cacheTtl: 60,
  collectLogs: true,
});
