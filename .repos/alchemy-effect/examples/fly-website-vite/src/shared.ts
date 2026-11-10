import * as Fly from "@alchemy.run/fly";

export const API_PORT = 3000;

export const Db = Fly.Postgres("Db", { region: "iad" });
