import * as profiles from "@distilled.cloud/aws/route53profiles";
import * as Layer from "effect/Layer";
import { makeProfilesHttpBinding } from "./BindingHttp.ts";
import { ListProfileAssociations } from "./ListProfileAssociations.ts";

export const ListProfileAssociationsHttp = Layer.effect(
  ListProfileAssociations,
  makeProfilesHttpBinding({
    tag: "AWS.Route53Profiles.ListProfileAssociations",
    operation: profiles.listProfileAssociations,
    actions: ["route53profiles:ListProfileAssociations"],
  }),
);
