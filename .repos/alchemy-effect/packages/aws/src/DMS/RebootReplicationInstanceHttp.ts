import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsInstanceScopedHttpBinding } from "./BindingHttp.ts";
import { RebootReplicationInstance } from "./RebootReplicationInstance.ts";

export const RebootReplicationInstanceHttp = Layer.effect(
  RebootReplicationInstance,
  makeDmsInstanceScopedHttpBinding({
    tag: "AWS.DMS.RebootReplicationInstance",
    actions: ["dms:RebootReplicationInstance"],
    operation: dms.rebootReplicationInstance,
    iam: "resource",
  }),
);
