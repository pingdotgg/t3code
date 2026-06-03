import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { Gateway } from "./src/AiGateway.ts";
import Api from "./src/Api.ts";
import { Bucket } from "./src/Bucket.ts";
import SecondaryApiLive, { SecondaryApi } from "./src/SecondaryApi.ts";
import WorkerTagLive, { WorkerTag } from "./src/WorkerTag.ts";

// Demo Action — runs at deploy time when its input (the resolved deployed
// URL) changes. Logs the new URL and returns a tiny manifest used as the
// stack output. Re-deploys with no changes skip the body.
const AnnounceDeploy = Alchemy.Action(
  "AnnounceDeploy",
  (input: { url: string; bucket: string }) =>
    Effect.gen(function* () {
      yield* Effect.log(`Deployed ${input.url} (bucket: ${input.bucket})`);
      return { deployedAt: new Date().toISOString(), url: input.url };
    }),
);

export default Alchemy.Stack(
  "CloudflareWorkerExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const bucket = yield* Bucket;
    const gateway = yield* Gateway;
    const workerTag = yield* WorkerTag;
    // Two Workers binding the same Agent DO triggers the regression where
    // a single Container DO namespace appears in multiple bindings on the
    // Sandbox ContainerApplication. See SecondaryApi.ts for details.
    const secondaryApi = yield* SecondaryApi;
    // The Queue consumer is wired automatically by
    // `Cloudflare.messages(Queue).subscribe(...)` inside src/Api.ts —
    // no explicit `Cloudflare.QueueConsumer(...)` is needed here.

    const announcement = yield* AnnounceDeploy({
      url: api.url.as<string>(),
      bucket: bucket.bucketName,
    });

    return {
      url: api.url.as<string>(),
      bucket: bucket.bucketName,
      gatewayId: gateway.gatewayId,
      workerTagUrl: workerTag.url.as<string>(),
      secondaryApiUrl: secondaryApi.url.as<string>(),
      deployedAt: announcement.deployedAt,
    };
  }).pipe(Effect.provide(WorkerTagLive), Effect.provide(SecondaryApiLive)),
);
