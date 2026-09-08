import * as Railway from "alchemy/Railway";

export const Site = Railway.Project("Site");

export const Db = Railway.Postgres("Db", { project: Site });
