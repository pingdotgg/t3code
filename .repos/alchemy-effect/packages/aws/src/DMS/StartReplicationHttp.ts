import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { StartReplication } from "./StartReplication.ts";

export const StartReplicationHttp = Layer.effect(
  StartReplication,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.StartReplication",
    actions: ["dms:StartReplication"],
    operation: dms.startReplication,
  }),
);
