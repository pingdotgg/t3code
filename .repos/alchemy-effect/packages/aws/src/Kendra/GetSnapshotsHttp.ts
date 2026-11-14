import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { GetSnapshots } from "./GetSnapshots.ts";

export const GetSnapshotsHttp = Layer.effect(
  GetSnapshots,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.GetSnapshots",
    operation: kendra.getSnapshots,
    actions: ["kendra:GetSnapshots"],
  }),
);
