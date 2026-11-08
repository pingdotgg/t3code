import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { makeImageBinding } from "./MicrovmBinding.ts";
import { ResumeMicrovm } from "./ResumeMicrovm.ts";

export const ResumeMicrovmHttp = makeImageBinding({
  binding: ResumeMicrovm,
  name: "ResumeMicrovm",
  actions: ["lambda:ResumeMicrovm"],
  operation: microvms.resumeMicrovm,
  scope: "microvm",
});
