import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { ListKeywordsForDataSource } from "./ListKeywordsForDataSource.ts";

export const ListKeywordsForDataSourceHttp = Layer.effect(
  ListKeywordsForDataSource,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ListKeywordsForDataSource",
    operation: auditmanager.listKeywordsForDataSource,
    actions: ["auditmanager:ListKeywordsForDataSource"],
  }),
);
