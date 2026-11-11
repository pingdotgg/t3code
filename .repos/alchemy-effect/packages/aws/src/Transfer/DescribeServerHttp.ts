import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import { makeTransferServerHttpBinding } from "./BindingHttp.ts";
import { DescribeServer } from "./DescribeServer.ts";

export const DescribeServerHttp = Layer.effect(
  DescribeServer,
  makeTransferServerHttpBinding({
    tag: "AWS.Transfer.DescribeServer",
    operation: transfer.describeServer,
    actions: ["transfer:DescribeServer"],
  }),
);
