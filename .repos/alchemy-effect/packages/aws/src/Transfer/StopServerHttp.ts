import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import { makeTransferServerHttpBinding } from "./BindingHttp.ts";
import { StopServer } from "./StopServer.ts";

export const StopServerHttp = Layer.effect(
  StopServer,
  makeTransferServerHttpBinding({
    tag: "AWS.Transfer.StopServer",
    operation: transfer.stopServer,
    actions: ["transfer:StopServer"],
  }),
);
