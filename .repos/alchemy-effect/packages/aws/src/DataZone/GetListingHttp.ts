import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetListing } from "./GetListing.ts";

export const GetListingHttp = Layer.effect(
  GetListing,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetListing",
    operation: datazone.getListing,
    actions: ["datazone:GetListing"],
  }),
);
