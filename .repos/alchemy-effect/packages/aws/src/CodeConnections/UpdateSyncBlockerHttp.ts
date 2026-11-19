import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeSyncConfigurationScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateSyncBlocker } from "./UpdateSyncBlocker.ts";

export const UpdateSyncBlockerHttp = Layer.effect(
  UpdateSyncBlocker,
  makeSyncConfigurationScopedHttpBinding({
    tag: "AWS.CodeConnections.UpdateSyncBlocker",
    actions: ["codeconnections:UpdateSyncBlocker"],
    operation: codeconnections.updateSyncBlocker,
  }),
);
