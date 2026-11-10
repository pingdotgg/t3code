import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeSyncConfigurationScopedHttpBinding } from "./BindingHttp.ts";
import { GetSyncBlockerSummary } from "./GetSyncBlockerSummary.ts";

export const GetSyncBlockerSummaryHttp = Layer.effect(
  GetSyncBlockerSummary,
  makeSyncConfigurationScopedHttpBinding({
    tag: "AWS.CodeConnections.GetSyncBlockerSummary",
    actions: ["codeconnections:GetSyncBlockerSummary"],
    operation: codeconnections.getSyncBlockerSummary,
  }),
);
