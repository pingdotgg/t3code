import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { makePublicRegistryHttpBinding } from "./BindingHttp.ts";
import { GetRegistryCatalogData } from "./GetRegistryCatalogData.ts";

export const GetRegistryCatalogDataHttp = Layer.effect(
  GetRegistryCatalogData,
  makePublicRegistryHttpBinding({
    capability: "GetRegistryCatalogData",
    iamActions: ["ecr-public:GetRegistryCatalogData"],
    operation: ecrpublic.getRegistryCatalogData,
  }),
);
