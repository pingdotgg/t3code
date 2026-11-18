import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { DeclineHandshake } from "./DeclineHandshake.ts";

export const DeclineHandshakeHttp = Layer.effect(
  DeclineHandshake,
  makeOrganizationsHttpBinding({
    capability: "DeclineHandshake",
    iamActions: ["organizations:DeclineHandshake"],
    operation: organizations.declineHandshake,
  }),
);
