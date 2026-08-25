import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { ListCategories } from "./ListCategories.ts";

export const ListCategoriesHttp = Layer.effect(
  ListCategories,
  makeQAppsInstanceHttpBinding({
    capability: "ListCategories",
    iamActions: ["qapps:ListCategories"],
    operation: qapps.listCategories,
  }),
);
