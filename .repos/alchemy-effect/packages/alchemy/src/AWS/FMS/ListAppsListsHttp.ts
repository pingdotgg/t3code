import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { ListAppsLists } from "./ListAppsLists.ts";

export const ListAppsListsHttp = Layer.effect(
  ListAppsLists,
  makeFmsHttpBinding({
    capability: "ListAppsLists",
    iamActions: ["fms:ListAppsLists"],
    operation: fms.listAppsLists,
  }),
);
