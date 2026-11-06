import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { ListMicrovmImageVersions } from "./ListMicrovmImageVersions.ts";
import { makeImageBinding } from "./MicrovmBinding.ts";

export const ListMicrovmImageVersionsHttp = makeImageBinding({
  binding: ListMicrovmImageVersions,
  name: "ListMicrovmImageVersions",
  actions: ["lambda:ListMicrovmImageVersions"],
  operation: microvms.listMicrovmImageVersions,
  scope: "image",
  injectImageIdentifier: true,
});
