import { Endpoint } from "@distilled.cloud/aws";
import * as Region from "@distilled.cloud/aws/Region";
import * as sfn from "@distilled.cloud/aws/sfn";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeStateMachineArnHttpBinding } from "./BindingHttp.ts";
import { StartSyncExecution } from "./StartSyncExecution.ts";

/**
 * `StartSyncExecution` must target the `sync-states.{region}` endpoint
 * (the Smithy `hostPrefix: "sync-"` endpoint trait) — the regular
 * `states.{region}` endpoint rejects it. distilled applies the host
 * prefix itself; the explicit Endpoint here additionally pins the
 * correct host for runtimes bundled against a distilled build that
 * predates host-prefix support.
 */
const startSyncExecutionOnSyncEndpoint = Effect.gen(function* () {
  const regionEffect = yield* Region.Region;
  const syncStatesEndpoint: Effect.Effect<string | undefined> = Effect.map(
    regionEffect,
    (region) => `https://sync-states.${region}.amazonaws.com`,
  );
  return yield* sfn.startSyncExecution.pipe(
    Effect.provideService(Endpoint.Endpoint, syncStatesEndpoint),
  );
});

export const StartSyncExecutionHttp = Layer.effect(
  StartSyncExecution,
  makeStateMachineArnHttpBinding({
    tag: "AWS.StepFunctions.StartSyncExecution",
    operation: startSyncExecutionOnSyncEndpoint,
    actions: ["states:StartSyncExecution"],
  }),
);
