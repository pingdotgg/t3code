import * as Cloudflare from "alchemy/Cloudflare";

export const Visits = Cloudflare.KV.Namespace("Visits");
