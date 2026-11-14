import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeReplications } from "./DescribeReplications.ts";

export const DescribeReplicationsHttp = Layer.effect(
  DescribeReplications,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.DescribeReplications",
    actions: ["dms:DescribeReplications"],
    operation: dms.describeReplications,
  }),
);
