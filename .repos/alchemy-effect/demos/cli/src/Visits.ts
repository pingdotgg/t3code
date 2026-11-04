import * as Cloudflare from "@alchemy.run/cloudflare";

export const Visits = Cloudflare.KV.Namespace("Visits");
