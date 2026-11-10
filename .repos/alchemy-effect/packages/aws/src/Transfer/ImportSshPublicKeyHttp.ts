import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import { makeTransferUserHttpBinding } from "./BindingHttp.ts";
import { ImportSshPublicKey } from "./ImportSshPublicKey.ts";

export const ImportSshPublicKeyHttp = Layer.effect(
  ImportSshPublicKey,
  makeTransferUserHttpBinding({
    tag: "AWS.Transfer.ImportSshPublicKey",
    operation: transfer.importSshPublicKey,
    actions: ["transfer:ImportSshPublicKey"],
  }),
);
