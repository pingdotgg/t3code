import * as AWS from "alchemy/AWS";

export const Database = AWS.DSQL.Cluster("Database", {
  deletionProtectionEnabled: false,
});
