import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Layer from "effect/Layer";
import { makeMediaConvertHttpBinding } from "./BindingHttp.ts";
import { ListJobs } from "./ListJobs.ts";

export const ListJobsHttp = Layer.effect(
  ListJobs,
  makeMediaConvertHttpBinding({
    capability: "ListJobs",
    iamActions: ["mediaconvert:ListJobs"],
    operation: mediaconvert.listJobs,
  }),
);
