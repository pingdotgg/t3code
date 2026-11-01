import * as Cloudflare from "alchemy/Cloudflare";

export const DB = Cloudflare.D1.Database("Db", {
  migrations: "./migrations",
});

export const KV = Cloudflare.KV.Namespace("KV");
