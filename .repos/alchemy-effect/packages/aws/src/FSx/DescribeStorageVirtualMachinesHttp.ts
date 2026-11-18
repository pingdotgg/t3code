import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeStorageVirtualMachines } from "./DescribeStorageVirtualMachines.ts";

export const DescribeStorageVirtualMachinesHttp = Layer.effect(
  DescribeStorageVirtualMachines,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.DescribeStorageVirtualMachines",
    operation: fsx.describeStorageVirtualMachines,
    actions: ["fsx:DescribeStorageVirtualMachines"],
  }),
);
