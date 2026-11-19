import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { ListAccessControlConfigurations } from "./ListAccessControlConfigurations.ts";

export const ListAccessControlConfigurationsHttp = Layer.effect(
  ListAccessControlConfigurations,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.ListAccessControlConfigurations",
    operation: kendra.listAccessControlConfigurations,
    actions: ["kendra:ListAccessControlConfigurations"],
  }),
);
