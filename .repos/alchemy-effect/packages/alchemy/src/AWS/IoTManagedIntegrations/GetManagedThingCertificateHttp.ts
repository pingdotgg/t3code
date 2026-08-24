import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedThingHttpBinding } from "./BindingHttp.ts";
import { GetManagedThingCertificate } from "./GetManagedThingCertificate.ts";

export const GetManagedThingCertificateHttp = Layer.effect(
  GetManagedThingCertificate,
  makeManagedThingHttpBinding({
    capability: "GetManagedThingCertificate",
    iamActions: ["iotmanagedintegrations:GetManagedThingCertificate"],
    operation: mi.getManagedThingCertificate,
    key: "Identifier",
  }),
);
