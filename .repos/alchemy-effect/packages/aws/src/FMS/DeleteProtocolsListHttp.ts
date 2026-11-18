import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { DeleteProtocolsList } from "./DeleteProtocolsList.ts";

export const DeleteProtocolsListHttp = Layer.effect(
  DeleteProtocolsList,
  makeFmsHttpBinding({
    capability: "DeleteProtocolsList",
    iamActions: ["fms:DeleteProtocolsList"],
    operation: fms.deleteProtocolsList,
  }),
);
