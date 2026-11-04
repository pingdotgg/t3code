import * as Cloudflare from "@alchemy.run/cloudflare";

export const Db = Cloudflare.D1.Database("Db", { migrations: "./migrations" });
