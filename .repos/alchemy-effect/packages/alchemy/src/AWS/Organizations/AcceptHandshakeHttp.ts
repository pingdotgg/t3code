import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { AcceptHandshake } from "./AcceptHandshake.ts";

export const AcceptHandshakeHttp = Layer.effect(
  AcceptHandshake,
  makeOrganizationsHttpBinding({
    capability: "AcceptHandshake",
    iamActions: ["organizations:AcceptHandshake"],
    operation: organizations.acceptHandshake,
  }),
);
