import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { GetImageSetMetadata } from "./GetImageSetMetadata.ts";

export const GetImageSetMetadataHttp = Layer.effect(
  GetImageSetMetadata,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.GetImageSetMetadata",
    operation: medicalimaging.getImageSetMetadata,
    actions: ["medical-imaging:GetImageSetMetadata"],
  }),
);
