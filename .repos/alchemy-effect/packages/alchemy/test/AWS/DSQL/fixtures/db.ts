import * as DSQL from "@/AWS/DSQL";

/**
 * Shared Aurora DSQL cluster for the Connect e2e fixtures. Both Lambda
 * fixtures yield this same logical resource, so a single cluster backs the
 * Drizzle path and the direct public-endpoint path.
 */
export const Db = DSQL.Cluster("Db", {});
