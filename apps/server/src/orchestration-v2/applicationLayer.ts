import * as Layer from "effect/Layer";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { layer as projectServiceLayer } from "../project/ProjectService.ts";
import { layer as threadLaunchServiceLayer } from "./ThreadLaunchService.ts";
import { layer as threadLifecycleServiceLayer } from "./ThreadLifecycleService.ts";
import { live as resourceCleanupLive } from "./ResourceCleanupService.ts";
import { observerLive as runFinalizationObserverLive } from "./RunFinalizationService.ts";

const projectServiceProvided = projectServiceLayer.pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
);

const applicationServices = Layer.mergeAll(
  threadLaunchServiceLayer,
  threadLifecycleServiceLayer,
).pipe(Layer.provideMerge(projectServiceProvided));

export const OrchestrationV2ApplicationLayer = Layer.mergeAll(
  applicationServices,
  resourceCleanupLive,
  runFinalizationObserverLive,
);
