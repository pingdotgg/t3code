import { Postgres } from "@/Railway/Postgres.ts";
import { Partition, Site } from "./suite-env.ts";

export { Site };

export const Db = Postgres("Db", { project: Site, environment: Partition });
