import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import {
  makeNeptuneGraphGraphHttpBinding,
  SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { ListGraphSnapshots } from "./ListGraphSnapshots.ts";

export const ListGraphSnapshotsHttp = Layer.effect(
  ListGraphSnapshots,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.ListGraphSnapshots",
    operation: neptunegraph.listGraphSnapshots,
    actions: ["neptune-graph:ListGraphSnapshots"],
    extraResources: [SNAPSHOT_ARN_WILDCARD],
  }),
);
