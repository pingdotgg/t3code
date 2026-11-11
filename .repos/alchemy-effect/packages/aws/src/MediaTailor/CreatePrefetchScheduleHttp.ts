import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorPlaybackHttpBinding } from "./BindingHttp.ts";
import { CreatePrefetchSchedule } from "./CreatePrefetchSchedule.ts";

export const CreatePrefetchScheduleHttp = Layer.effect(
  CreatePrefetchSchedule,
  makeMediaTailorPlaybackHttpBinding({
    capability: "CreatePrefetchSchedule",
    iamActions: ["mediatailor:CreatePrefetchSchedule"],
    operation: mediatailor.createPrefetchSchedule,
  }),
);
