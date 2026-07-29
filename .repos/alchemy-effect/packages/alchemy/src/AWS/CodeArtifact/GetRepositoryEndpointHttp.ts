import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";
import { GetRepositoryEndpoint } from "./GetRepositoryEndpoint.ts";

/** HTTP implementation of {@link GetRepositoryEndpoint} over the CodeArtifact API. */
export const GetRepositoryEndpointHttp = Layer.effect(
  GetRepositoryEndpoint,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.GetRepositoryEndpoint",
    operation: codeartifact.getRepositoryEndpoint,
    actions: ["codeartifact:GetRepositoryEndpoint"],
  }),
);
