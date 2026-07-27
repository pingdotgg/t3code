import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { makeImageBinding } from "./MicrovmBinding.ts";
import { RunMicrovm } from "./RunMicrovm.ts";

export const RunMicrovmHttp = makeImageBinding({
  binding: RunMicrovm,
  name: "RunMicrovm",
  actions: ["lambda:RunMicrovm"],
  operation: microvms.runMicrovm,
  scope: "image",
  injectImageIdentifier: true,
  passNetworkConnector: true,
});
