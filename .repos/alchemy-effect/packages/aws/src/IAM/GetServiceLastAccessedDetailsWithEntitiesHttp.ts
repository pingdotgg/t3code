import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { GetServiceLastAccessedDetailsWithEntities } from "./GetServiceLastAccessedDetailsWithEntities.ts";

export const GetServiceLastAccessedDetailsWithEntitiesHttp = Layer.effect(
  GetServiceLastAccessedDetailsWithEntities,
  makeIamHttpBinding({
    capability: "GetServiceLastAccessedDetailsWithEntities",
    iamActions: ["iam:GetServiceLastAccessedDetailsWithEntities"],
    operation: iam.getServiceLastAccessedDetailsWithEntities,
  }),
);
