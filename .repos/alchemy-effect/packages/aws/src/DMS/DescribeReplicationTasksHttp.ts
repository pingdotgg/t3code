import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeReplicationTasks } from "./DescribeReplicationTasks.ts";

export const DescribeReplicationTasksHttp = Layer.effect(
  DescribeReplicationTasks,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.DescribeReplicationTasks",
    actions: ["dms:DescribeReplicationTasks"],
    operation: dms.describeReplicationTasks,
  }),
);
