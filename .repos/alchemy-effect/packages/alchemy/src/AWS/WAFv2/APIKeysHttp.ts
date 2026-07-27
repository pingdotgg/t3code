import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import {
  CreateAPIKey,
  DeleteAPIKey,
  GetDecryptedAPIKey,
  ListAPIKeys,
} from "./APIKeys.ts";
import { makeWafv2AccountHttpBinding } from "./BindingHttp.ts";

export const CreateAPIKeyHttp = Layer.effect(
  CreateAPIKey,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.CreateAPIKey",
    operation: wafv2.createAPIKey,
    actions: ["wafv2:CreateAPIKey"],
  }),
);

export const GetDecryptedAPIKeyHttp = Layer.effect(
  GetDecryptedAPIKey,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.GetDecryptedAPIKey",
    operation: wafv2.getDecryptedAPIKey,
    actions: ["wafv2:GetDecryptedAPIKey"],
  }),
);

export const ListAPIKeysHttp = Layer.effect(
  ListAPIKeys,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.ListAPIKeys",
    operation: wafv2.listAPIKeys,
    actions: ["wafv2:ListAPIKeys"],
  }),
);

export const DeleteAPIKeyHttp = Layer.effect(
  DeleteAPIKey,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.DeleteAPIKey",
    operation: wafv2.deleteAPIKey,
    actions: ["wafv2:DeleteAPIKey"],
  }),
);
