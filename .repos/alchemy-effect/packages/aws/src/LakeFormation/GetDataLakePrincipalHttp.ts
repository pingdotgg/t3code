import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { GetDataLakePrincipal } from "./GetDataLakePrincipal.ts";

export const GetDataLakePrincipalHttp = Layer.effect(
  GetDataLakePrincipal,
  makeLakeFormationHttpBinding({
    capability: "GetDataLakePrincipal",
    iamActions: ["lakeformation:GetDataLakePrincipal"],
    operation: lf.getDataLakePrincipal,
  }),
);
