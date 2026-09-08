import * as AWS from "@/AWS";
import { MultiRegionEndpoint } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class EndpointStillExists extends Data.TaggedError("EndpointStillExists")<{
  readonly name: string;
}> {}

const getEndpoint = (name: string) =>
  sesv2
    .getMultiRegionEndpoint({ EndpointName: name })
    .pipe(
      Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
    );

const assertEndpointDeleted = (name: string) =>
  getEndpoint(name).pipe(
    Effect.flatMap((found) =>
      found ? Effect.fail(new EndpointStillExists({ name })) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "EndpointStillExists",
      // Deletion is asynchronous (DELETING -> gone); poll a bounded window.
      schedule: Schedule.max([Schedule.exponential(1000), Schedule.recurs(10)]),
    }),
  );

// A multi-region endpoint costs nothing to provision — SES charges $0.03/1k
// emails routed through it and nothing for the endpoint itself — so this runs
// ungated. Provisioning is asynchronous: create returns CREATING and reaching
// READY exceeds the polling budget, so the lifecycle asserts CREATING and
// deletes from there rather than waiting.
test.provider(
  "multi-region endpoint lifecycle: create (CREATING), verify, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const endpoint = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* MultiRegionEndpoint("Global", {
            regions: ["eu-west-1"],
          });
        }),
      );

      expect(endpoint.endpointName).toBeDefined();
      expect(endpoint.endpointId).toBeDefined();
      // Reconcile does not wait for READY, so the status is CREATING (or READY
      // if provisioning was unusually fast).
      expect(["CREATING", "READY"]).toContain(endpoint.status);

      // out-of-band verification via distilled
      const observed = yield* getEndpoint(endpoint.endpointName);
      expect(observed?.EndpointId).toBe(endpoint.endpointId);

      yield* stack.destroy();
      yield* assertEndpointDeleted(endpoint.endpointName);
    }),
  // Measured ~113s: create returns immediately at CREATING, but the delete
  // cannot land until SES finishes provisioning (it answers
  // ConcurrentModificationException until then), so the wall-clock floor is
  // AWS-side provisioning time. 120s left no headroom and flaked; the wait is
  // bounded by the provider's retry schedule, not by this timeout.
  { timeout: 180_000 },
);
