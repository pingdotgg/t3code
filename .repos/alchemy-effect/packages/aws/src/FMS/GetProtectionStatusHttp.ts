import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetProtectionStatus } from "./GetProtectionStatus.ts";

export const GetProtectionStatusHttp = Layer.effect(
  GetProtectionStatus,
  makeFmsHttpBinding({
    capability: "GetProtectionStatus",
    iamActions: ["fms:GetProtectionStatus"],
    operation: fms.getProtectionStatus,
  }),
);
