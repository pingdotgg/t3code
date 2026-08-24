import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { CreateShellAuthToken } from "./CreateShellAuthToken.ts";
import { makeImageBinding } from "./MicrovmBinding.ts";

export const CreateShellAuthTokenHttp = makeImageBinding({
  binding: CreateShellAuthToken,
  name: "CreateShellAuthToken",
  actions: ["lambda:CreateMicrovmShellAuthToken"],
  operation: microvms.createMicrovmShellAuthToken,
  scope: "microvm",
});
