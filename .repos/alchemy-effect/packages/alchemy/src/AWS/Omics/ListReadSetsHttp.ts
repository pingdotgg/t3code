import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { ListReadSets } from "./ListReadSets.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const ListReadSetsHttp = Layer.effect(
  ListReadSets,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.ListReadSets",
    operation: omics.listReadSets,
    actions: ["omics:ListReadSets"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
