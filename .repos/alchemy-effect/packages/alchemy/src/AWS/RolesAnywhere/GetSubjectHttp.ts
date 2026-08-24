import * as rolesanywhere from "@distilled.cloud/aws/rolesanywhere";
import * as Layer from "effect/Layer";
import { makeRolesAnywhereHttpBinding } from "./BindingHttp.ts";
import { GetSubject } from "./GetSubject.ts";

export const GetSubjectHttp = Layer.effect(
  GetSubject,
  makeRolesAnywhereHttpBinding({
    capability: "GetSubject",
    iamActions: ["rolesanywhere:GetSubject"],
    operation: rolesanywhere.getSubject,
  }),
);
