import * as securitylake from "@distilled.cloud/aws/securitylake";
import * as Layer from "effect/Layer";
import { makeSecurityLakeDataLakeHttpBinding } from "./BindingHttp.ts";
import { ListDataLakeExceptions } from "./ListDataLakeExceptions.ts";

export const ListDataLakeExceptionsHttp = Layer.effect(
  ListDataLakeExceptions,
  makeSecurityLakeDataLakeHttpBinding({
    tag: "AWS.SecurityLake.ListDataLakeExceptions",
    operation: securitylake.listDataLakeExceptions,
    actions: ["securitylake:ListDataLakeExceptions"],
  }),
);
