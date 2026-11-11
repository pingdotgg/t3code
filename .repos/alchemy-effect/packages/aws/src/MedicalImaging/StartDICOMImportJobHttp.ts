import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingStartJobHttpBinding } from "./BindingHttp.ts";
import { StartDICOMImportJob } from "./StartDICOMImportJob.ts";

export const StartDICOMImportJobHttp = Layer.effect(
  StartDICOMImportJob,
  makeMedicalImagingStartJobHttpBinding({
    tag: "AWS.MedicalImaging.StartDICOMImportJob",
    operation: medicalimaging.startDICOMImportJob,
    actions: ["medical-imaging:StartDICOMImportJob"],
  }),
);
