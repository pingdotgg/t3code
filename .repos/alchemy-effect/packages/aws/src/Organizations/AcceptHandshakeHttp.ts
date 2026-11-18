import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { AcceptHandshake } from "./AcceptHandshake.ts";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

export const AcceptHandshakeHttp = Layer.effect(
  AcceptHandshake,
  makeOrganizationsHttpBinding({
    capability: "AcceptHandshake",
    iamActions: ["organizations:AcceptHandshake"],
    operation: organizations.acceptHandshake,
  }),
);
