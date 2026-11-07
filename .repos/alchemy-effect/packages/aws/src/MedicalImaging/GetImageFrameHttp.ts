import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { GetImageFrame } from "./GetImageFrame.ts";

export const GetImageFrameHttp = Layer.effect(
  GetImageFrame,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.GetImageFrame",
    operation: medicalimaging.getImageFrame,
    actions: ["medical-imaging:GetImageFrame"],
  }),
);
