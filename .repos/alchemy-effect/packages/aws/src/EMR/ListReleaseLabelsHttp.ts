import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrAccountHttpBinding } from "./BindingHttp.ts";
import { ListReleaseLabels } from "./ListReleaseLabels.ts";

export const ListReleaseLabelsHttp = Layer.effect(
  ListReleaseLabels,
  makeEmrAccountHttpBinding({
    tag: "AWS.EMR.ListReleaseLabels",
    operation: emr.listReleaseLabels,
    actions: ["elasticmapreduce:ListReleaseLabels"],
  }),
);
