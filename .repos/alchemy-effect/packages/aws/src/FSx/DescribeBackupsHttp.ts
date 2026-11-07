import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeBackups } from "./DescribeBackups.ts";

export const DescribeBackupsHttp = Layer.effect(
  DescribeBackups,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.DescribeBackups",
    operation: fsx.describeBackups,
    actions: ["fsx:DescribeBackups"],
  }),
);
