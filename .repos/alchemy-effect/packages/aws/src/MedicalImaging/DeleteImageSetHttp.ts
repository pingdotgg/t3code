import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { DeleteImageSet } from "./DeleteImageSet.ts";

export const DeleteImageSetHttp = Layer.effect(
  DeleteImageSet,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.DeleteImageSet",
    operation: medicalimaging.deleteImageSet,
    actions: ["medical-imaging:DeleteImageSet"],
  }),
);
