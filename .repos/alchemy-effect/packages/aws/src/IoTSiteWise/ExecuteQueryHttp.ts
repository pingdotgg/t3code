import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Layer from "effect/Layer";
import { makeSiteWiseAccountHttpBinding } from "./BindingHttp.ts";
import { ExecuteQuery } from "./ExecuteQuery.ts";

export const ExecuteQueryHttp = Layer.effect(
  ExecuteQuery,
  makeSiteWiseAccountHttpBinding({
    capability: "ExecuteQuery",
    iamActions: ["iotsitewise:ExecuteQuery"],
    operation: sitewise.executeQuery,
  }),
);
