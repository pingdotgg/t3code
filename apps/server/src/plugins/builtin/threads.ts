import { builtinLifecycleLayer, builtinService } from "@t3tools/shared/pluginKernel";
import * as StorageCleanup from "../../storageCleanup.ts";
import * as PullRequestSyncReactor from "../../orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "../../orchestration-v2/PullRequestWatchReactor.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as ProviderUsageAnalytics from "../../telemetry/ProviderUsageAnalytics.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";
import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "../../orchestration-v2/NativeChildWorkQuery.ts";
import * as ProjectSettingsOverrideSweep from "../../provider/ProjectSettingsOverrideSweep.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  relayHookBaseUrl,
  ScheduledTaskWebhookOrigin,
} from "../../scheduledTasks/ScheduledTaskService.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  decodeRuntimeConfig,
  RELAY_URL_SECRET,
} from "../../cloud/config.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as ThreadSettlementService from "../../orchestration-v2/ThreadSettlementService.ts";
import * as ThreadPullRequestService from "../../orchestration-v2/ThreadPullRequestService.ts";
import * as RunFinalizationService from "../../orchestration-v2/RunFinalizationService.ts";
import * as ProjectionStoreV2 from "../../orchestration-v2/ProjectionStore.ts";
import * as TaskFolders from "../../workspace/TaskFolders.ts";
import * as TaskFolderStore from "../../workspace/TaskFolderStore.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  layerPullRequestService,
  layerGitWorkflow,
  layerCheckpointStore,
} from "./sourceControl.ts";

// Webhook URLs go through the relay only when the managed tunnel it forwards
// to is configured; otherwise clients show the environment-relative path.
const layerScheduledTaskWebhookOrigin = Layer.effect(
  ScheduledTaskWebhookOrigin,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    // The reference holds an effect so each read sees the current link state.
    return Effect.gen(function* () {
      const [relayUrl, tunnelConfig] = yield* Effect.all([
        secrets.get(RELAY_URL_SECRET),
        secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      ]).pipe(Effect.orElseSucceed(() => [Option.none(), Option.none()] as const));
      if (Option.isNone(relayUrl) || Option.isNone(tunnelConfig)) {
        return { relayHookBaseUrl: null };
      }
      const config = decodeRuntimeConfig(new TextDecoder().decode(tunnelConfig.value));
      return {
        relayHookBaseUrl: relayHookBaseUrl({
          relayUrl: new TextDecoder().decode(relayUrl.value),
          tunnelName: Option.isSome(config) ? config.value.tunnelName : undefined,
        }),
      };
    });
  }),
);

export const layerTaskFolders = TaskFolders.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TaskFolderStore.layer,
      ProjectStore.layer,
      ProjectionStoreV2.layer,
      VcsProcess.layer,
    ),
  ),
  Layer.provide(layerGitWorkflow),
);

const layerOrchestrationV2Runtime = RuntimeLayer.layerProduction.pipe(
  Layer.provide(UsageLimitSources.layerResetFallback),
  Layer.provide(layerTaskFolders),
  Layer.provide(layerScheduledTaskWebhookOrigin),
  Layer.provide(ProviderUsageAnalytics.layer),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerGitWorkflow),
  Layer.provide(
    RunFinalizationService.layerObserver.pipe(
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(layerPullRequestService),
      Layer.provide(RuntimeLayer.layerProjectService),
    ),
  ),
);

export const layerPluginEventSink = RuntimeLayer.layerEventSink;

export const layerOrchestrationApplication = Layer.merge(
  CheckpointDiffQuery.layer,
  NativeChildWorkQuery.layer,
).pipe(Layer.provideMerge(layerCheckpointStore), Layer.provideMerge(layerOrchestrationV2Runtime));

// Automatic thread settlement: a server-owned sweep evaluates
// inactivity and merged pull requests, then settles through the orchestrator
// so every client sees the same shelf.
export const layerThreadSettlementWorker = builtinLifecycleLayer(
  "t3.thread",
  "t3/server/root/lifecycle-1",
  builtinService(
    "t3.pull-requests",
    "t3/server/root/thread-settlement-pull-requests",
    ThreadSettlementService.make.pipe(
      Effect.flatMap((service) => service.start()),
      Effect.as({}),
    ),
    { lifecycle: true },
  ),
).pipe(Layer.provide(layerPullRequestService), Layer.provide(ProjectionStoreV2.layer));

export const layerThreadPullRequestWorker = builtinLifecycleLayer(
  "t3.thread",
  "t3/server/root/lifecycle-2",
  builtinService(
    "t3.pull-requests",
    "t3/server/root/thread-pull-requests",
    ThreadPullRequestService.make.pipe(
      Effect.flatMap((service) => service.start()),
      Effect.as({}),
    ),
    { lifecycle: true },
  ),
).pipe(Layer.provide(layerPullRequestService));

export const layerStorageCleanup = StorageCleanup.layer.pipe(
  Layer.provide(ProjectionStoreV2.layer),
);

export const layerPullRequestSyncWorker = builtinLifecycleLayer(
  "t3.thread",
  "t3/server/root/lifecycle-5",
  builtinService(
    "t3.pull-requests",
    "t3/server/root/pull-request-sync",
    Effect.gen(function* () {
      const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      yield* service.start();
      return {};
    }),
    { lifecycle: true },
  ),
).pipe(
  Layer.provideMerge(PullRequestSyncReactor.layer),
  Layer.provide(layerPullRequestService),
  Layer.provide(ProjectionStoreV2.layer),
);

export const layerPullRequestWatchWorker = builtinLifecycleLayer(
  "t3.thread",
  "t3/server/root/lifecycle-6",
  builtinService(
    "t3.pull-requests",
    "t3/server/root/pull-request-watch",
    Effect.gen(function* () {
      const service = yield* PullRequestWatchReactor.PullRequestWatchReactor;
      yield* service.start();
      return {};
    }),
    { lifecycle: true },
  ),
).pipe(
  Layer.provide(PullRequestWatchReactor.layer),
  Layer.provide(layerPullRequestService),
  Layer.provide(ProjectionStoreV2.layer),
);

export const layerProjectSettingsOverrideSweep = builtinLifecycleLayer(
  "t3.thread",
  "t3/server/root/project-settings-override-sweep",
  ProjectSettingsOverrideSweep.sweep,
);

export const layerEventInfrastructure = RuntimeLayer.layerEventInfrastructure;

export const layerProjectStoreAndSearch = Layer.merge(ProjectStore.layer, ThreadSearch.layer);
