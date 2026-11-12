import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { PutAppsList } from "./PutAppsList.ts";

export const PutAppsListHttp = Layer.effect(
  PutAppsList,
  makeFmsHttpBinding({
    capability: "PutAppsList",
    iamActions: ["fms:PutAppsList"],
    operation: fms.putAppsList,
  }),
);
