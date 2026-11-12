import * as rolesanywhere from "@distilled.cloud/aws/rolesanywhere";
import * as Layer from "effect/Layer";
import { makeRolesAnywhereHttpBinding } from "./BindingHttp.ts";
import { ListSubjects } from "./ListSubjects.ts";

export const ListSubjectsHttp = Layer.effect(
  ListSubjects,
  makeRolesAnywhereHttpBinding({
    capability: "ListSubjects",
    iamActions: ["rolesanywhere:ListSubjects"],
    operation: rolesanywhere.listSubjects,
  }),
);
