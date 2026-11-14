import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { ListLaunchPaths } from "./ListLaunchPaths.ts";

export const ListLaunchPathsHttp = Layer.effect(
  ListLaunchPaths,
  makeServiceCatalogHttpBinding({
    capability: "ListLaunchPaths",
    iamActions: ["servicecatalog:ListLaunchPaths"],
    operation: servicecatalog.listLaunchPaths,
  }),
);
