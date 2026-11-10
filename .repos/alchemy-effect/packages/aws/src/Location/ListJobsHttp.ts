import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationAccountHttpBinding } from "./BindingHttp.ts";
import { ListJobs } from "./ListJobs.ts";

export const ListJobsHttp = Layer.effect(
  ListJobs,
  makeLocationAccountHttpBinding({
    tag: "AWS.Location.ListJobs",
    operation: location.listJobs,
    actions: ["geo:ListJobs"],
  }),
);
