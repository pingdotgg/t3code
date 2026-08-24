import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { CreateAuthToken } from "./CreateAuthToken.ts";
import { makeImageBinding } from "./MicrovmBinding.ts";

export const CreateAuthTokenHttp = makeImageBinding({
  binding: CreateAuthToken,
  name: "CreateAuthToken",
  actions: ["lambda:CreateMicrovmAuthToken"],
  operation: microvms.createMicrovmAuthToken,
  scope: "microvm",
});
