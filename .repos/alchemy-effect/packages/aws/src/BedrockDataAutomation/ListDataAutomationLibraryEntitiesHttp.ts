import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Layer from "effect/Layer";
import { makeBdaLibraryHttpBinding } from "./BindingHttp.ts";
import { ListDataAutomationLibraryEntities } from "./ListDataAutomationLibraryEntities.ts";

export const ListDataAutomationLibraryEntitiesHttp = Layer.effect(
  ListDataAutomationLibraryEntities,
  makeBdaLibraryHttpBinding({
    tag: "AWS.BedrockDataAutomation.ListDataAutomationLibraryEntities",
    operation: bda.listDataAutomationLibraryEntities,
    actions: ["bedrock:ListDataAutomationLibraryEntities"],
  }),
);
