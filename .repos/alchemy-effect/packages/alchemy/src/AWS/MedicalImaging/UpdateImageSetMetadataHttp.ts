import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { UpdateImageSetMetadata } from "./UpdateImageSetMetadata.ts";

export const UpdateImageSetMetadataHttp = Layer.effect(
  UpdateImageSetMetadata,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.UpdateImageSetMetadata",
    operation: medicalimaging.updateImageSetMetadata,
    actions: ["medical-imaging:UpdateImageSetMetadata"],
  }),
);
