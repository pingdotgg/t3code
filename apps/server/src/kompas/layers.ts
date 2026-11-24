import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as KompasApps from "./KompasApps.ts";
import * as KompasDatabase from "./KompasDatabase.ts";
import * as KompasRpc from "./KompasRpc.ts";
import * as KompasSettingsStore from "./KompasSettingsStore.ts";
import * as LearningService from "./LearningService.ts";
import * as MemoryService from "./MemoryService.ts";
import * as PluginProxy from "./PluginProxy.ts";
import * as PluginService from "./PluginService.ts";
import * as PluginStore from "./PluginStore.ts";
import * as ThreadFiles from "./ThreadFiles.ts";
import * as ThreadProfiles from "./ThreadProfiles.ts";
import * as WidgetDocument from "./WidgetDocument.ts";
import * as WidgetTools from "./WidgetTools.ts";
import * as WorkstreamService from "./WorkstreamService.ts";
import * as WorkstreamStore from "./WorkstreamStore.ts";

/** Everything below the orchestrator. Layers memoize by reference, so every provider shares it. */
export const layerCore = Layer.mergeAll(
  PluginService.layer,
  MemoryService.layer,
  LearningService.layer,
).pipe(
  Layer.provideMerge(PluginProxy.layer),
  Layer.provideMerge(Layer.mergeAll(PluginStore.layer, WorkstreamStore.layer)),
  Layer.provideMerge(KompasSettingsStore.layer),
  Layer.provideMerge(KompasDatabase.layer),
);

export const layerThreadProfiles = ThreadProfiles.layer.pipe(
  Layer.provide(layerCore),
  Layer.provide(ProjectStore.layer),
);

/** What needs the orchestrator: project threads, and the handlers clients call. */
export const layerApplication = Layer.mergeAll(
  KompasRpc.layer,
  KompasApps.layer,
  ThreadFiles.layer,
  Layer.effectDiscard(
    Effect.flatMap(WorkstreamService.WorkstreamService, (service) => service.start()),
  ),
).pipe(
  Layer.provideMerge(Layer.merge(WidgetTools.layer, WidgetDocument.layer)),
  Layer.provideMerge(WorkstreamService.layer),
  Layer.provideMerge(Layer.merge(layerCore, layerThreadProfiles)),
);
