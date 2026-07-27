import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { makePublicRegistryHttpBinding } from "./BindingHttp.ts";
import { GetAuthorizationToken } from "./GetAuthorizationToken.ts";

export const GetAuthorizationTokenHttp = Layer.effect(
  GetAuthorizationToken,
  makePublicRegistryHttpBinding({
    capability: "GetAuthorizationToken",
    // The API requires both permissions; see the GetAuthorizationToken docs.
    iamActions: [
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ],
    operation: ecrpublic.getAuthorizationToken,
  }),
);
