import * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import * as Layer from "effect/Layer";
import { makeDataExportsAccountHttpBinding } from "./BindingHttp.ts";
import { ListExports } from "./ListExports.ts";

export const ListExportsHttp = Layer.effect(
  ListExports,
  makeDataExportsAccountHttpBinding({
    capability: "ListExports",
    iamActions: ["bcm-data-exports:ListExports"],
    operation: bcm.listExports,
  }),
);
