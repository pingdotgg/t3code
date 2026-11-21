import { builtinServiceLayer } from "@t3tools/shared/pluginKernel";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PullRequestHttp from "../../pullRequest/http.ts";
import * as PullRequestProviderRegistry from "../../pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as PullRequestFilesViewed from "../../persistence/PullRequestFilesViewed.ts";
import * as PullRequestReviewGuides from "../../persistence/PullRequestReviewGuides.ts";
import * as PullRequestReviewGuideService from "../../pullRequest/PullRequestReviewGuideService.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as SourceControlBuiltInDrivers from "../../sourceControl/builtInDrivers.ts";
import * as SourceControlSignIn from "../../sourceControl/SourceControlSignIn.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "../../sourceControl/sourceControlDefinitions.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../../vcs/VcsProjectConfig.ts";
import * as VcsProvisioningService from "../../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ReviewService from "../../review/ReviewService.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "../../pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStoreV2 from "../../orchestration-v2/ProjectionStore.ts";
import { layerKnownWorkspaces } from "./workspace.ts";

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer));

export const layerSourceControlProviderRegistry = SourceControlProviderRegistry.layer.pipe(
  Layer.provideMerge(SourceControlBuiltInDrivers.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

export const layerRepositoryIdentityResolver = builtinServiceLayer("t3.server")(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    return yield* RepositoryIdentityResolver.make({
      // Each host that can refine an identity gets a turn; the first one that changes it wins.
      refine: Effect.fn(function* (identity: RepositoryIdentity) {
        for (const { kind } of BUILT_IN_SOURCE_CONTROL_DRIVER_LIST) {
          const provider = yield* registry.get(kind);
          if (provider.refineRepositoryIdentity === undefined) continue;
          const refined = yield* provider.refineRepositoryIdentity({
            identity,
            resolveContext: (input) =>
              registry.resolveHandle(input).pipe(Effect.map((handle) => handle.context)),
          });
          if (refined !== identity) return refined;
        }
        return identity;
      }),
    });
  }),
).pipe(Layer.provide(layerSourceControlProviderRegistry), Layer.provide(ProcessRunner.layer));

export const layerPullRequestService = PullRequestService.layer.pipe(
  Layer.provide(PullRequestProviderRegistry.layer),
  // Where the viewed-file marks live for a host that keeps none of its own.
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(layerSourceControlProviderRegistry),
  Layer.provide(SourceControlRateLimit.layer),
);

const layerGitManager = GitManager.layer.pipe(
  // Per-project git settings resolve the acting thread's project.
  Layer.provide(Layer.merge(ProjectionStoreV2.layer, ProjectStore.layer)),
  Layer.provide(layerPullRequestService.pipe(Layer.provide(RuntimeLayer.layerProjectService))),
  Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(TextGeneration.layer.pipe(Layer.provide(layerSourceControlProviderRegistry))),
);

export const layerGit = Layer.empty.pipe(
  Layer.provideMerge(layerGitManager),
  Layer.provideMerge(GitVcsDriver.layer),
);

export const layerGitWorkflow = GitWorkflowService.layer.pipe(
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(layerGit),
);

const layerSourceControlRepositoryService = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
);

const layerProjectCloneTracker = ProjectCloneTracker.layer.pipe(
  Layer.provide(layerSourceControlRepositoryService),
);

const layerReview = ReviewService.layer.pipe(
  Layer.provideMerge(layerKnownWorkspaces),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

export const layerVcs = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
  Layer.provideMerge(layerGitWorkflow),
  Layer.provideMerge(layerReview),
  Layer.provideMerge(layerSourceControlRepositoryService),
  Layer.provideMerge(
    SourceControlSignIn.layer.pipe(Layer.provide(layerSourceControlProviderRegistry)),
  ),
  Layer.provideMerge(layerProjectCloneTracker),
  Layer.provideMerge(
    VcsStatusBroadcaster.layer.pipe(
      Layer.provide(layerGitWorkflow),
      // Auto-pull reads the project row. The orchestration runtime also
      // consumes the broadcaster (run finalization), so the policy cannot read
      // the store from the runtime's output.
      Layer.provide(
        VcsStatusBroadcaster.layerAutoPullPolicy.pipe(Layer.provide(ProjectStore.layer)),
      ),
    ),
  ),
);

export const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistry),
);

export const layerPullRequestHttp = PullRequestHttp.layer;

export const layerPullRequestReviewGuideService = PullRequestReviewGuideService.layer.pipe(
  Layer.provide(PullRequestReviewGuides.layer),
);
