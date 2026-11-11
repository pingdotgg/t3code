import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";
import { RegisterAdmin } from "./RegisterAdmin.ts";

export const RegisterAdminHttp = Layer.effect(
  RegisterAdmin,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.RegisterAdmin",
    operation: repostspace.registerAdmin,
    actions: ["repostspace:RegisterAdmin"],
  }),
);
