import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { PutProtocolsList } from "./PutProtocolsList.ts";

export const PutProtocolsListHttp = Layer.effect(
  PutProtocolsList,
  makeFmsHttpBinding({
    capability: "PutProtocolsList",
    iamActions: ["fms:PutProtocolsList"],
    operation: fms.putProtocolsList,
  }),
);
