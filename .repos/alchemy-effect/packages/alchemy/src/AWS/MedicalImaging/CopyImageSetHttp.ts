import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { CopyImageSet } from "./CopyImageSet.ts";

export const CopyImageSetHttp = Layer.effect(
  CopyImageSet,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.CopyImageSet",
    operation: medicalimaging.copyImageSet,
    actions: ["medical-imaging:CopyImageSet"],
  }),
);
