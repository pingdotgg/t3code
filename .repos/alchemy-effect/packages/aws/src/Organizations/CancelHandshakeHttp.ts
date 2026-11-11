import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { CancelHandshake } from "./CancelHandshake.ts";

export const CancelHandshakeHttp = Layer.effect(
  CancelHandshake,
  makeOrganizationsHttpBinding({
    capability: "CancelHandshake",
    iamActions: ["organizations:CancelHandshake"],
    operation: organizations.cancelHandshake,
  }),
);
