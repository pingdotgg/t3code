import * as Railway from "@alchemy.run/railway";

export const Site = Railway.Project("Site");

export const Db = Railway.Postgres("Db", { project: Site });
