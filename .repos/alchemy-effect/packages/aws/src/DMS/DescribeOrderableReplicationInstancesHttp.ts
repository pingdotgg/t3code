import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeOrderableReplicationInstances } from "./DescribeOrderableReplicationInstances.ts";

export const DescribeOrderableReplicationInstancesHttp = Layer.effect(
  DescribeOrderableReplicationInstances,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.DescribeOrderableReplicationInstances",
    actions: ["dms:DescribeOrderableReplicationInstances"],
    operation: dms.describeOrderableReplicationInstances,
  }),
);
