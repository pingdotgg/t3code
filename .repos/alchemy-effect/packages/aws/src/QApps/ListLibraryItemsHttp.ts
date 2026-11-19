import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { ListLibraryItems } from "./ListLibraryItems.ts";

export const ListLibraryItemsHttp = Layer.effect(
  ListLibraryItems,
  makeQAppsInstanceHttpBinding({
    capability: "ListLibraryItems",
    iamActions: ["qapps:ListLibraryItems"],
    operation: qapps.listLibraryItems,
  }),
);
