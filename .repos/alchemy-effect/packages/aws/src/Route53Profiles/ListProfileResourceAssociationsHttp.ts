import * as profiles from "@distilled.cloud/aws/route53profiles";
import * as Layer from "effect/Layer";
import { makeProfilesHttpBinding } from "./BindingHttp.ts";
import { ListProfileResourceAssociations } from "./ListProfileResourceAssociations.ts";

export const ListProfileResourceAssociationsHttp = Layer.effect(
  ListProfileResourceAssociations,
  makeProfilesHttpBinding({
    tag: "AWS.Route53Profiles.ListProfileResourceAssociations",
    operation: profiles.listProfileResourceAssociations,
    actions: ["route53profiles:ListProfileResourceAssociations"],
  }),
);
