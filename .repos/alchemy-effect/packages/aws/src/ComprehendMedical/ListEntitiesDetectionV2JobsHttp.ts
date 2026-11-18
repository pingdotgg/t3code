import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { ListEntitiesDetectionV2Jobs } from "./ListEntitiesDetectionV2Jobs.ts";

export const ListEntitiesDetectionV2JobsHttp = Layer.effect(
  ListEntitiesDetectionV2Jobs,
  makeComprehendMedicalHttpBinding({
    capability: "ListEntitiesDetectionV2Jobs",
    iamActions: ["comprehendmedical:ListEntitiesDetectionV2Jobs"],
    operation: comprehendmedical.listEntitiesDetectionV2Jobs,
  }),
);
