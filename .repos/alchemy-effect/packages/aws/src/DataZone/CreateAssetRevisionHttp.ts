import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { CreateAssetRevision } from "./CreateAssetRevision.ts";

export const CreateAssetRevisionHttp = Layer.effect(
  CreateAssetRevision,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.CreateAssetRevision",
    operation: datazone.createAssetRevision,
    actions: ["datazone:CreateAssetRevision"],
  }),
);
