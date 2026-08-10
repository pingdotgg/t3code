import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeSyncConfigurationScopedHttpBinding } from "./BindingHttp.ts";
import { GetResourceSyncStatus } from "./GetResourceSyncStatus.ts";

export const GetResourceSyncStatusHttp = Layer.effect(
  GetResourceSyncStatus,
  makeSyncConfigurationScopedHttpBinding({
    tag: "AWS.CodeConnections.GetResourceSyncStatus",
    actions: ["codeconnections:GetResourceSyncStatus"],
    operation: codeconnections.getResourceSyncStatus,
  }),
);
