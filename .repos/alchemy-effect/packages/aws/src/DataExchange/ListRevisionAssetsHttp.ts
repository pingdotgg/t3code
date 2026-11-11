import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeRevisionHttpBinding } from "./BindingHttp.ts";
import { ListRevisionAssets } from "./ListRevisionAssets.ts";

export const ListRevisionAssetsHttp = Layer.effect(
  ListRevisionAssets,
  makeRevisionHttpBinding({
    tag: "AWS.DataExchange.ListRevisionAssets",
    operation: dataexchange.listRevisionAssets,
    actions: ["dataexchange:ListRevisionAssets"],
  }),
);
