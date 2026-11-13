import * as Schema from "effect/Schema";
import {
  ProjectSnapshot,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ThreadProjection,
  OrchestrationV2Command,
  OrchestrationV2DispatchCommandResult,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

export const hostApiSchemas = {
  ProjectSnapshot,
  ThreadShellSnapshot: OrchestrationV2ThreadShellSnapshot,
  ThreadSnapshot: Schema.Struct({
    schemaVersion: Schema.Number,
    snapshotSequence: Schema.Number,
    projection: OrchestrationV2ThreadProjection,
  }),
  OrchestrationCommand: OrchestrationV2Command,
  DispatchResult: OrchestrationV2DispatchCommandResult,
  ServerSettings,
  ServerSettingsPatch,
};
