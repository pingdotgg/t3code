import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { makeImageBinding } from "./MicrovmBinding.ts";
import { TerminateMicrovm } from "./TerminateMicrovm.ts";

export const TerminateMicrovmHttp = makeImageBinding({
  binding: TerminateMicrovm,
  name: "TerminateMicrovm",
  actions: ["lambda:TerminateMicrovm"],
  operation: microvms.terminateMicrovm,
  scope: "microvm",
});
