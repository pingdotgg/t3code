import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { makePublicRepositoryHttpBinding } from "./BindingHttp.ts";
import { GetRepositoryCatalogData } from "./GetRepositoryCatalogData.ts";

export const GetRepositoryCatalogDataHttp = Layer.effect(
  GetRepositoryCatalogData,
  makePublicRepositoryHttpBinding({
    capability: "GetRepositoryCatalogData",
    iamActions: ["ecr-public:GetRepositoryCatalogData"],
    operation: ecrpublic.getRepositoryCatalogData,
  }),
);
