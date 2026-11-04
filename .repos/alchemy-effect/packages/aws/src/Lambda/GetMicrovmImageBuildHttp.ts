import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { GetMicrovmImageBuild } from "./GetMicrovmImageBuild.ts";
import { makeImageBinding } from "./MicrovmBinding.ts";

export const GetMicrovmImageBuildHttp = makeImageBinding({
  binding: GetMicrovmImageBuild,
  name: "GetMicrovmImageBuild",
  actions: ["lambda:GetMicrovmImageBuild"],
  operation: microvms.getMicrovmImageBuild,
  scope: "image",
  injectImageIdentifier: true,
});
