import * as AWS from "@alchemy.run/aws";

export const Database = AWS.DSQL.Cluster("Database", {
  deletionProtectionEnabled: false,
});
