import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetUserProfile } from "./GetUserProfile.ts";

export const GetUserProfileHttp = Layer.effect(
  GetUserProfile,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetUserProfile",
    operation: datazone.getUserProfile,
    actions: ["datazone:GetUserProfile"],
  }),
);
