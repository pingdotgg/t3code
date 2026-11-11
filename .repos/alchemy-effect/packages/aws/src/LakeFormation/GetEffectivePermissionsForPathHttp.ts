import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { GetEffectivePermissionsForPath } from "./GetEffectivePermissionsForPath.ts";

export const GetEffectivePermissionsForPathHttp = Layer.effect(
  GetEffectivePermissionsForPath,
  makeLakeFormationHttpBinding({
    capability: "GetEffectivePermissionsForPath",
    iamActions: ["lakeformation:GetEffectivePermissionsForPath"],
    operation: lf.getEffectivePermissionsForPath,
  }),
);
