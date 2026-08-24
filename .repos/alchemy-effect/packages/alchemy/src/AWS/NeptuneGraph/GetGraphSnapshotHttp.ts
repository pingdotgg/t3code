import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import {
  makeNeptuneGraphAccountHttpBinding,
  SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { GetGraphSnapshot } from "./GetGraphSnapshot.ts";

export const GetGraphSnapshotHttp = Layer.effect(
  GetGraphSnapshot,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.GetGraphSnapshot",
    operation: neptunegraph.getGraphSnapshot,
    actions: ["neptune-graph:GetGraphSnapshot"],
    resources: [SNAPSHOT_ARN_WILDCARD],
  }),
);
