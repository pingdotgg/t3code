import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle =
  !!process.env.GCP_TEST_COMPUTE_INTERCONNECT && !process.env.FAST;

const waitUntilGone = (interconnectGroup: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getInterconnectGroups({ project, interconnectGroup }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status === "gone",
          times: 10,
        }),
      ),
    ),
  );

test.provider(
  "getInterconnectGroups on a missing group fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getInterconnectGroups({
          project,
          interconnectGroup: "alchemy-missing-ixg",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an interconnect group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.InterconnectGroup("Bundle", {
            description: "dev interconnects",
            intent: { topologyCapability: "NO_SLA" },
          });
        }),
      );

      expect(created.interconnectGroupName).toEqual(expect.any(String));
      expect(created.description).toEqual("dev interconnects");

      const fetched = yield* compute.getInterconnectGroups({
        project: created.project,
        interconnectGroup: created.interconnectGroupName,
      });
      expect(fetched.name).toEqual(created.interconnectGroupName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.InterconnectGroup("Bundle", {
            interconnectGroupName: created.interconnectGroupName,
            description: "updated interconnects",
            intent: { topologyCapability: "NO_SLA" },
          });
        }),
      );
      expect(updated.description).toEqual("updated interconnects");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.interconnectGroupName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
