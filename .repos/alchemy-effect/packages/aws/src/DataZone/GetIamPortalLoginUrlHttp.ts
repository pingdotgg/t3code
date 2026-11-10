import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetIamPortalLoginUrl } from "./GetIamPortalLoginUrl.ts";

export const GetIamPortalLoginUrlHttp = Layer.effect(
  GetIamPortalLoginUrl,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetIamPortalLoginUrl",
    operation: datazone.getIamPortalLoginUrl,
    actions: ["datazone:GetIamPortalLoginUrl"],
  }),
);
