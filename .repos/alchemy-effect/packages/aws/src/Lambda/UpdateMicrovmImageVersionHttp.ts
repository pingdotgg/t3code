import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { makeImageBinding } from "./MicrovmBinding.ts";
import { UpdateMicrovmImageVersion } from "./UpdateMicrovmImageVersion.ts";

export const UpdateMicrovmImageVersionHttp = makeImageBinding({
  binding: UpdateMicrovmImageVersion,
  name: "UpdateMicrovmImageVersion",
  actions: ["lambda:UpdateMicrovmImageVersion"],
  operation: microvms.updateMicrovmImageVersion,
  scope: "image",
  injectImageIdentifier: true,
});
