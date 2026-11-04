import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { GetDICOMImportJob } from "./GetDICOMImportJob.ts";

export const GetDICOMImportJobHttp = Layer.effect(
  GetDICOMImportJob,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.GetDICOMImportJob",
    operation: medicalimaging.getDICOMImportJob,
    actions: ["medical-imaging:GetDICOMImportJob"],
  }),
);
