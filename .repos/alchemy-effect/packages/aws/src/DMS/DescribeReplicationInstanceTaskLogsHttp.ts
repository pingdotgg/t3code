import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsInstanceScopedHttpBinding } from "./BindingHttp.ts";
import { DescribeReplicationInstanceTaskLogs } from "./DescribeReplicationInstanceTaskLogs.ts";

export const DescribeReplicationInstanceTaskLogsHttp = Layer.effect(
  DescribeReplicationInstanceTaskLogs,
  makeDmsInstanceScopedHttpBinding({
    tag: "AWS.DMS.DescribeReplicationInstanceTaskLogs",
    actions: ["dms:DescribeReplicationInstanceTaskLogs"],
    operation: dms.describeReplicationInstanceTaskLogs,
    iam: "wildcard",
  }),
);
