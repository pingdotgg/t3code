import * as Fly from "alchemy/Fly";

export const API_PORT = 3000;

export const Site = Fly.App("Site", {
  enableSubdomains: true,
});

export const Data = Fly.Bucket("Data");

export const PublicIp = Fly.IpAssignment("Shared", {
  app: Site,
  type: "shared_v4",
});
