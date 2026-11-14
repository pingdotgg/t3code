import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import { makeTransferUserHttpBinding } from "./BindingHttp.ts";
import { DeleteSshPublicKey } from "./DeleteSshPublicKey.ts";

export const DeleteSshPublicKeyHttp = Layer.effect(
  DeleteSshPublicKey,
  makeTransferUserHttpBinding({
    tag: "AWS.Transfer.DeleteSshPublicKey",
    operation: transfer.deleteSshPublicKey,
    actions: ["transfer:DeleteSshPublicKey"],
  }),
);
