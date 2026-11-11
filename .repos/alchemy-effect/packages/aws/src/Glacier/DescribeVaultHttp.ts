import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { DescribeVault } from "./DescribeVault.ts";

export const DescribeVaultHttp = Layer.effect(
  DescribeVault,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.DescribeVault",
    operation: glacier.describeVault,
    actions: ["glacier:DescribeVault"],
  }),
);
