import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeConnections } from "./DescribeConnections.ts";

export const DescribeConnectionsHttp = Layer.effect(
  DescribeConnections,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.DescribeConnections",
    actions: ["dms:DescribeConnections"],
    operation: dms.describeConnections,
  }),
);
