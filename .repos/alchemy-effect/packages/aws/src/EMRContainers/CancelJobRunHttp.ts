import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Layer from "effect/Layer";
import { makeEMRContainersVirtualClusterHttpBinding } from "./BindingHttp.ts";
import { CancelJobRun } from "./CancelJobRun.ts";

export const CancelJobRunHttp = Layer.effect(
  CancelJobRun,
  makeEMRContainersVirtualClusterHttpBinding({
    tag: "AWS.EMRContainers.CancelJobRun",
    operation: emrc.cancelJobRun,
    actions: ["emr-containers:CancelJobRun"],
  }),
);
