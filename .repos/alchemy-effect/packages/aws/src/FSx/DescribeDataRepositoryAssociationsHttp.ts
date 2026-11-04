import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDataRepositoryAssociations } from "./DescribeDataRepositoryAssociations.ts";

export const DescribeDataRepositoryAssociationsHttp = Layer.effect(
  DescribeDataRepositoryAssociations,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.DescribeDataRepositoryAssociations",
    operation: fsx.describeDataRepositoryAssociations,
    actions: ["fsx:DescribeDataRepositoryAssociations"],
  }),
);
