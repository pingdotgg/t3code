import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Layer from "effect/Layer";
import { makeEMRContainersVirtualClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeManagedEndpoint } from "./DescribeManagedEndpoint.ts";

export const DescribeManagedEndpointHttp = Layer.effect(
  DescribeManagedEndpoint,
  makeEMRContainersVirtualClusterHttpBinding({
    tag: "AWS.EMRContainers.DescribeManagedEndpoint",
    operation: emrc.describeManagedEndpoint,
    actions: ["emr-containers:DescribeManagedEndpoint"],
  }),
);
