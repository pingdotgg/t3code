import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { ListDatasourcePackages } from "./ListDatasourcePackages.ts";

export const ListDatasourcePackagesHttp = Layer.effect(
  ListDatasourcePackages,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.ListDatasourcePackages",
    operation: detective.listDatasourcePackages,
    actions: ["detective:ListDatasourcePackages"],
  }),
);
