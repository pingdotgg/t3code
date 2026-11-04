import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsInstanceHttpBinding } from "./BindingHttp.ts";
import { StartDBInstance } from "./StartDBInstance.ts";

export const StartDBInstanceHttp = Layer.effect(
  StartDBInstance,
  makeRdsInstanceHttpBinding({
    tag: "AWS.RDS.StartDBInstance",
    operation: rds.startDBInstance,
    actions: ["rds:StartDBInstance"],
  }),
);
