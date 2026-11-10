import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { ListDICOMImportJobs } from "./ListDICOMImportJobs.ts";

export const ListDICOMImportJobsHttp = Layer.effect(
  ListDICOMImportJobs,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.ListDICOMImportJobs",
    operation: medicalimaging.listDICOMImportJobs,
    actions: ["medical-imaging:ListDICOMImportJobs"],
  }),
);
