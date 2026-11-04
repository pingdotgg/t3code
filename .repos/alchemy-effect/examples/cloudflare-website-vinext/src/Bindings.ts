import * as Cloudflare from "@alchemy.run/cloudflare";

export const DB = Cloudflare.D1.Database("Db", {
  migrations: "./migrations",
});

export const KV = Cloudflare.KV.Namespace("KV");
