import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Layer from "effect/Layer";
import { makeEMRContainersVirtualClusterHttpBinding } from "./BindingHttp.ts";
import { ListJobRuns } from "./ListJobRuns.ts";

export const ListJobRunsHttp = Layer.effect(
  ListJobRuns,
  makeEMRContainersVirtualClusterHttpBinding({
    tag: "AWS.EMRContainers.ListJobRuns",
    operation: emrc.listJobRuns,
    actions: ["emr-containers:ListJobRuns"],
  }),
);
