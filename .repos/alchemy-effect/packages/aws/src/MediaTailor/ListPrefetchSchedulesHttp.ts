import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorPlaybackHttpBinding } from "./BindingHttp.ts";
import { ListPrefetchSchedules } from "./ListPrefetchSchedules.ts";

export const ListPrefetchSchedulesHttp = Layer.effect(
  ListPrefetchSchedules,
  makeMediaTailorPlaybackHttpBinding({
    capability: "ListPrefetchSchedules",
    iamActions: ["mediatailor:ListPrefetchSchedules"],
    operation: mediatailor.listPrefetchSchedules,
  }),
);
