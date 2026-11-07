import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsAccountHttpBinding } from "./BindingHttp.ts";
import { ListRuns } from "./ListRuns.ts";

export const ListRunsHttp = Layer.effect(
  ListRuns,
  makeOmicsAccountHttpBinding({
    tag: "AWS.Omics.ListRuns",
    operation: omics.listRuns,
    actions: ["omics:ListRuns"],
  }),
);
