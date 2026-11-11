import { Postgres } from "@alchemy.run/railway/Postgres";
import { Partition, Site } from "./suite-env.ts";

export { Site };

export const Db = Postgres("Db", { project: Site, environment: Partition });
