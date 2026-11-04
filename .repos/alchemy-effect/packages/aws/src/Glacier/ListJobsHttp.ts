import * as glacier from "@distilled.cloud/aws/glacier";
import * as Layer from "effect/Layer";
import { makeGlacierVaultHttpBinding } from "./BindingHttp.ts";
import { ListJobs } from "./ListJobs.ts";

export const ListJobsHttp = Layer.effect(
  ListJobs,
  makeGlacierVaultHttpBinding({
    tag: "AWS.Glacier.ListJobs",
    operation: glacier.listJobs,
    actions: ["glacier:ListJobs"],
  }),
);
