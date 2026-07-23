/** Live service graph and scoped polling loop for local GitHub waitpoints. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as GitHubWaitpoints from "../persistence/GitHubWaitpoints.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubPullRequestProbe from "./GitHubPullRequestProbe.ts";
import * as GitHubWaitpointRegistration from "./GitHubWaitpointRegistration.ts";
import {
  GitHubWaitpointWorker,
  layer as workerLayer,
  threadGatewayLayer,
} from "./GitHubWaitpointWorker.ts";

const WORKER_TICK_INTERVAL = "5 seconds" as const;

const probeLayer = GitHubPullRequestProbe.layer.pipe(Layer.provide(GitHubCli.layer));

const registrationLayer = GitHubWaitpointRegistration.layer.pipe(
  Layer.provideMerge(GitHubWaitpoints.layer),
  Layer.provideMerge(probeLayer),
);

const workerServicesLayer = workerLayer.pipe(
  Layer.provideMerge(GitHubWaitpoints.layer),
  Layer.provideMerge(probeLayer),
  Layer.provideMerge(threadGatewayLayer),
);

const workerLoopLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* GitHubWaitpointWorker;
    const tick = worker.processDue.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("github.waitpoint.worker.tick-failed", { cause }),
      ),
    );
    yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(WORKER_TICK_INTERVAL))));
  }),
).pipe(Layer.provideMerge(workerServicesLayer));

export const layer = Layer.merge(registrationLayer, workerLoopLayer);
