import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as Layer from "effect/Layer";
import { makeMedicalImagingDatastoreHttpBinding } from "./BindingHttp.ts";
import { SearchImageSets } from "./SearchImageSets.ts";

export const SearchImageSetsHttp = Layer.effect(
  SearchImageSets,
  makeMedicalImagingDatastoreHttpBinding({
    tag: "AWS.MedicalImaging.SearchImageSets",
    operation: medicalimaging.searchImageSets,
    actions: ["medical-imaging:SearchImageSets"],
  }),
);
