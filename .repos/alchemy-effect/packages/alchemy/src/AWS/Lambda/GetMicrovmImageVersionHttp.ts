import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { GetMicrovmImageVersion } from "./GetMicrovmImageVersion.ts";
import { makeImageBinding } from "./MicrovmBinding.ts";

export const GetMicrovmImageVersionHttp = makeImageBinding({
  binding: GetMicrovmImageVersion,
  name: "GetMicrovmImageVersion",
  actions: ["lambda:GetMicrovmImageVersion"],
  operation: microvms.getMicrovmImageVersion,
  scope: "image",
  injectImageIdentifier: true,
});
