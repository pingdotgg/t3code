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

const region = "us-central1";

const waitUntilGone = (nodeTemplate: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getNodeTemplates({ project, region, nodeTemplate }).pipe(
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
  "getNodeTemplates on a missing template fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getNodeTemplates({
          project,
          region,
          nodeTemplate: "alchemy-missing-nt",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "create and delete a node template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NodeTemplate("SoleTenant", {
            region,
            nodeType: "n2-node-80-640",
            description: "prod sole tenant",
          });
        }),
      );

      expect(created.nodeTemplateName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.description).toEqual("prod sole tenant");
      expect(created.nodeType).toEqual("n2-node-80-640");

      const fetched = yield* compute.getNodeTemplates({
        project: created.project,
        region,
        nodeTemplate: created.nodeTemplateName,
      });
      expect(fetched.name).toEqual(created.nodeTemplateName);
      expect(fetched.description).toContain("[alchemy ");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.nodeTemplateName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
