import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Layer from "effect/Layer";
import { makeEMRContainersVirtualClusterHttpBinding } from "./BindingHttp.ts";
import { ListManagedEndpoints } from "./ListManagedEndpoints.ts";

export const ListManagedEndpointsHttp = Layer.effect(
  ListManagedEndpoints,
  makeEMRContainersVirtualClusterHttpBinding({
    tag: "AWS.EMRContainers.ListManagedEndpoints",
    operation: emrc.listManagedEndpoints,
    actions: ["emr-containers:ListManagedEndpoints"],
  }),
);
