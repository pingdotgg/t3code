import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { CreatePresignedUrl } from "./CreatePresignedUrl.ts";

export const CreatePresignedUrlHttp = Layer.effect(
  CreatePresignedUrl,
  makeQAppHttpBinding({
    capability: "CreatePresignedUrl",
    iamActions: ["qapps:CreatePresignedUrl"],
    operation: qapps.createPresignedUrl,
    injectAppId: true,
  }),
);
