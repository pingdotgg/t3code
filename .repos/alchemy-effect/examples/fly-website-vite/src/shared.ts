import * as Fly from "alchemy/Fly";

export const API_PORT = 3000;

export const Site = Fly.App("Site", {
  enableSubdomains: true,
});

export const PublicIp = Fly.IpAssignment("Shared", {
  app: Site,
  type: "shared_v4",
});

export const Db = Fly.Postgres("Db", { region: "iad" });
