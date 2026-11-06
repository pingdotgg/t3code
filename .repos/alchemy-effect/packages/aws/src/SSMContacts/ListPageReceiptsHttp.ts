import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { ListPageReceipts } from "./ListPageReceipts.ts";

export const ListPageReceiptsHttp = Layer.effect(
  ListPageReceipts,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.ListPageReceipts",
    operation: ssm.listPageReceipts,
    actions: ["ssm-contacts:ListPageReceipts"],
  }),
);
