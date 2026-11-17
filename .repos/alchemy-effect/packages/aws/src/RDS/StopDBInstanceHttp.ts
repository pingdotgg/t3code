import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsInstanceHttpBinding } from "./BindingHttp.ts";
import { StopDBInstance } from "./StopDBInstance.ts";

export const StopDBInstanceHttp = Layer.effect(
  StopDBInstance,
  makeRdsInstanceHttpBinding({
    tag: "AWS.RDS.StopDBInstance",
    operation: rds.stopDBInstance,
    actions: ["rds:StopDBInstance"],
  }),
);
