import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (
  project: string,
  region: string,
  targetPoolName: string,
) =>
  compute.getTargetPools({ project, region, targetPool: targetPoolName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, replace, and delete a target pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.TargetPool("Pool", {
            region: "us-central1",
            description: "nlb backends",
          });
        }),
      );

      expect(created.targetPoolName).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.description).toEqual("nlb backends");
      expect(created.sessionAffinity).toEqual("NONE");
      expect(created.selfLink).toEqual(expect.stringContaining("targetPools"));

      const fetched = yield* compute.getTargetPools({
        project: created.project,
        region: created.region,
        targetPool: created.targetPoolName,
      });
      expect(fetched.name).toEqual(created.targetPoolName);
      expect(fetched.sessionAffinity).toEqual("NONE");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("nlb backends");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.TargetPool("Pool", {
            targetPoolName: created.targetPoolName,
            region: "us-central1",
            description: "nlb backends",
            sessionAffinity: "CLIENT_IP",
          });
        }),
      );

      expect(replaced.targetPoolName).toEqual(created.targetPoolName);
      expect(replaced.sessionAffinity).toEqual("CLIENT_IP");
      expect(replaced.description).toEqual("nlb backends");

      const refetched = yield* compute.getTargetPools({
        project: replaced.project,
        region: replaced.region,
        targetPool: replaced.targetPoolName,
      });
      expect(refetched.sessionAffinity).toEqual("CLIENT_IP");
      expect(refetched.description).toContain("[alchemy ");
      expect(refetched.description).toContain("nlb backends");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.region,
        created.targetPoolName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
