import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsAccountHttpBinding } from "./BindingHttp.ts";
import { ListVariantImportJobs } from "./ListVariantImportJobs.ts";

export const ListVariantImportJobsHttp = Layer.effect(
  ListVariantImportJobs,
  makeOmicsAccountHttpBinding({
    tag: "AWS.Omics.ListVariantImportJobs",
    operation: omics.listVariantImportJobs,
    actions: ["omics:ListVariantImportJobs"],
  }),
);
