import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import { makeTransferServerHttpBinding } from "./BindingHttp.ts";
import { StartServer } from "./StartServer.ts";

export const StartServerHttp = Layer.effect(
  StartServer,
  makeTransferServerHttpBinding({
    tag: "AWS.Transfer.StartServer",
    operation: transfer.startServer,
    actions: ["transfer:StartServer"],
  }),
);
