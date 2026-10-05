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
const poolName = "alchemy-fr-test-pool";

const waitUntilGone = (forwardingRuleName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getForwardingRules({
          project,
          region,
          forwardingRule: forwardingRuleName,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

const waitOp = (operation: compute.Operation) => {
  if (operation.status === "DONE") return Effect.succeed(operation);
  const name = (operation.name ?? "").split("/").pop() ?? "";
  return GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getRegionOperations({ project, region, operation: name }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (op) => op.status === "DONE",
          times: 12,
        }),
      ),
    ),
  );
};

const ensureTargetPool = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const existing = yield* compute
      .getTargetPools({ project, region, targetPool: poolName })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (existing !== undefined) return existing;
    yield* compute
      .insertTargetPools({
        project,
        region,
        body: { name: poolName, description: "alchemy forwarding-rule test" },
      })
      .pipe(
        Effect.flatMap(waitOp),
        Effect.catchTag("Conflict", () => Effect.void),
      );
    return yield* compute.getTargetPools({
      project,
      region,
      targetPool: poolName,
    });
  });

const deleteTargetPool = () =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.deleteTargetPools({ project, region, targetPool: poolName }).pipe(
        Effect.flatMap(waitOp),
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
      ),
    ),
  );

test.provider(
  "create, update, and delete a regional forwarding rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const pool = yield* ensureTargetPool();
      expect(pool.selfLink).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.ForwardingRule("Frontend", {
            region,
            target: pool.selfLink,
            ipProtocol: "TCP",
            portRange: "80",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.forwardingRuleName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.ipAddress).toEqual(expect.any(String));
      expect(created.ipProtocol).toEqual("TCP");
      expect(created.loadBalancingScheme).toEqual("EXTERNAL");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.target).toEqual(expect.stringContaining(poolName));

      const fetched = yield* compute.getForwardingRules({
        project: created.project,
        region: created.region,
        forwardingRule: created.forwardingRuleName,
      });
      expect(fetched.name).toEqual(created.forwardingRuleName);
      expect(fetched.IPAddress).toEqual(created.ipAddress);
      expect(fetched.IPProtocol).toEqual("TCP");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.target).toEqual(expect.stringContaining(poolName));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.ForwardingRule("Frontend", {
            forwardingRuleName: created.forwardingRuleName,
            region,
            target: pool.selfLink,
            ipProtocol: "TCP",
            portRange: "80",
            labels: { env: "prod", role: "frontend" },
          });
        }),
      );

      expect(updated.forwardingRuleName).toEqual(created.forwardingRuleName);
      expect(updated.ipAddress).toEqual(created.ipAddress);
      expect(updated.labels).toMatchObject({ env: "prod", role: "frontend" });

      const fetchedUpdated = yield* compute.getForwardingRules({
        project: updated.project,
        region: updated.region,
        forwardingRule: updated.forwardingRuleName,
      });
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("frontend");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.forwardingRuleName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, Effect.ensuring(deleteTargetPool().pipe(Effect.ignore))),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
