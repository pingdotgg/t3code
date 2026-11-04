import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedThingHttpBinding } from "./BindingHttp.ts";
import { GetManagedThingState } from "./GetManagedThingState.ts";

export const GetManagedThingStateHttp = Layer.effect(
  GetManagedThingState,
  makeManagedThingHttpBinding({
    capability: "GetManagedThingState",
    iamActions: ["iotmanagedintegrations:GetManagedThingState"],
    operation: mi.getManagedThingState,
    key: "ManagedThingId",
  }),
);
