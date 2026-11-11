import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { ListManagedMicrovmImageVersions } from "./ListManagedMicrovmImageVersions.ts";
import { makeAccountBinding } from "./MicrovmBinding.ts";

export const ListManagedMicrovmImageVersionsHttp = makeAccountBinding({
  binding: ListManagedMicrovmImageVersions,
  name: "ListManagedMicrovmImageVersions",
  actions: ["lambda:ListManagedMicrovmImageVersions"],
  operation: microvms.listManagedMicrovmImageVersions,
});
