import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { ListPermissions } from "./ListPermissions.ts";

export const ListPermissionsHttp = Layer.effect(
  ListPermissions,
  makeLakeFormationHttpBinding({
    capability: "ListPermissions",
    iamActions: ["lakeformation:ListPermissions"],
    operation: lf.listPermissions,
  }),
);
