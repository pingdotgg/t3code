import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { ListImageSetVersions } from "./ListImageSetVersions.ts";

export const ListImageSetVersionsHttp = Layer.effect(
  ListImageSetVersions,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.ListImageSetVersions",
    operation: medicalimaging.listImageSetVersions,
    actions: ["medical-imaging:ListImageSetVersions"],
  }),
);
