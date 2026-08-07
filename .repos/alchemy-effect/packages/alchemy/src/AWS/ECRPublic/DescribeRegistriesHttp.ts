import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { makePublicRegistryHttpBinding } from "./BindingHttp.ts";
import { DescribeRegistries } from "./DescribeRegistries.ts";

export const DescribeRegistriesHttp = Layer.effect(
  DescribeRegistries,
  makePublicRegistryHttpBinding({
    capability: "DescribeRegistries",
    iamActions: ["ecr-public:DescribeRegistries"],
    operation: ecrpublic.describeRegistries,
  }),
);
