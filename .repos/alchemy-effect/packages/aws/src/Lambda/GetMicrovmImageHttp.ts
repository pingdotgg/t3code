import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { GetMicrovmImage } from "./GetMicrovmImage.ts";
import { makeImageBinding } from "./MicrovmBinding.ts";

export const GetMicrovmImageHttp = makeImageBinding({
  binding: GetMicrovmImage,
  name: "GetMicrovmImage",
  actions: ["lambda:GetMicrovmImage"],
  operation: microvms.getMicrovmImage,
  scope: "image",
  injectImageIdentifier: true,
});
