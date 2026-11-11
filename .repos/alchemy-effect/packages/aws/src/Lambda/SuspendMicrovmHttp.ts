import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { makeImageBinding } from "./MicrovmBinding.ts";
import { SuspendMicrovm } from "./SuspendMicrovm.ts";

export const SuspendMicrovmHttp = makeImageBinding({
  binding: SuspendMicrovm,
  name: "SuspendMicrovm",
  actions: ["lambda:SuspendMicrovm"],
  operation: microvms.suspendMicrovm,
  scope: "microvm",
});
