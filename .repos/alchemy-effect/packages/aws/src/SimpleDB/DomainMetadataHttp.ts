import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Layer from "effect/Layer";
import { makeSimpleDbBinding } from "./Binding.ts";
import { DomainMetadata } from "./DomainMetadata.ts";

export const DomainMetadataHttp = Layer.effect(
  DomainMetadata,
  makeSimpleDbBinding({
    operation: "DomainMetadata",
    method: sdb.domainMetadata,
  }),
);
