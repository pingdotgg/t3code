import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { StopReplication } from "./StopReplication.ts";

export const StopReplicationHttp = Layer.effect(
  StopReplication,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.StopReplication",
    actions: ["dms:StopReplication"],
    operation: dms.stopReplication,
  }),
);
