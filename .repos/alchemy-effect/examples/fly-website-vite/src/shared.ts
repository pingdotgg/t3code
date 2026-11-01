import * as Fly from "alchemy/Fly";

export const API_PORT = 3000;

export const Db = Fly.Postgres("Db", { region: "iad" });
