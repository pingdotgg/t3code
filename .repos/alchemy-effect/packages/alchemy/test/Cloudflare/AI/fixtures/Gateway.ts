import * as Cloudflare from "@/Cloudflare/index.ts";

export const Gateway = Cloudflare.AI.Gateway("Gateway", {
  cacheTtl: 60,
  collectLogs: true,
});
