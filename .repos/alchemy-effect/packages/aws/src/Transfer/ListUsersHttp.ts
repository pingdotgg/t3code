import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import { makeTransferServerHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeTransferServerHttpBinding({
    tag: "AWS.Transfer.ListUsers",
    operation: transfer.listUsers,
    actions: ["transfer:ListUsers"],
  }),
);
