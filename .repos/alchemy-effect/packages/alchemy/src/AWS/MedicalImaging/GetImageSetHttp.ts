import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { GetImageSet } from "./GetImageSet.ts";

export const GetImageSetHttp = Layer.effect(
  GetImageSet,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.GetImageSet",
    operation: medicalimaging.getImageSet,
    actions: ["medical-imaging:GetImageSet"],
  }),
);
