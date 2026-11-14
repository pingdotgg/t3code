import * as efs from "@distilled.cloud/aws/efs";
import * as Layer from "effect/Layer";
import { makeEfsAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteAccessPoint } from "./DeleteAccessPoint.ts";

export const DeleteAccessPointHttp = Layer.effect(
  DeleteAccessPoint,
  makeEfsAccountHttpBinding({
    tag: "AWS.EFS.DeleteAccessPoint",
    operation: efs.deleteAccessPoint,
    actions: ["elasticfilesystem:DeleteAccessPoint"],
  }),
);
