import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { ReplicationSet } from "@/AWS/SSMIncidents/ReplicationSet.ts";
import { ResponsePlan } from "@/AWS/SSMIncidents/ResponsePlan.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// tags this provider's read/delete paths depend on. Run in every CI pass at
// near-zero cost, unlike the gated lifecycle below.
test.provider(
  "listReplicationSets succeeds whether or not Incident Manager is onboarded",
  () =>
    Effect.gen(function* () {
      const listed = yield* incidents.listReplicationSets({});
      expect(Array.isArray(listed.replicationSetArns)).toBe(true);
    }),
);

test.provider(
  "getReplicationSet on a nonexistent arn fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        incidents.getReplicationSet({
          arn: `arn:aws:ssm-incidents::${accountId}:replication-set/00000000-0000-4000-8000-000000000000`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getResponsePlan on a nonexistent arn fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;
      // Response plan ARNs are region-less (they live in the replication set).
      const error = yield* Effect.flip(
        incidents.getResponsePlan({
          arn: `arn:aws:ssm-incidents::${accountId}:response-plan/alchemy-nonexistent-probe`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// The replication set is the account/region singleton that ONBOARDS Incident
// Manager (create) and OFFBOARDS it account-wide (delete, ~1-2 minutes). The
// destructive lifecycle is gated behind AWS_TEST_INCIDENT_MANAGER=1 and only
// runs when the account is not already onboarded — it must never delete a
// replication set the user already operates (capture-and-restore safety).
test.provider.skipIf(!process.env.AWS_TEST_INCIDENT_MANAGER)(
  "lifecycle: onboard Incident Manager, deploy response plan, offboard",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* incidents.listReplicationSets({});
      if (preexisting.replicationSetArns.length > 0) {
        yield* Effect.logInfo(
          `Incident Manager already onboarded (${preexisting.replicationSetArns[0]}) — skipping destructive lifecycle test`,
        );
        return;
      }

      // AWS deprecated CreateReplicationSet on Nov 7, 2025 — accounts not
      // already onboarded to Incident Manager can no longer onboard. Probe
      // once and assert the typed deprecation tag; only a grandfathered
      // (pre-deprecation) account can exercise the full lifecycle below.
      const { region } = yield* AWSEnvironment.current;
      const onboarded = yield* Effect.result(
        incidents.createReplicationSet({ regions: { [region]: {} } }),
      );
      if (Result.isFailure(onboarded)) {
        expect(onboarded.failure._tag).toBe("UnsupportedOperationException");
        yield* Effect.logInfo(
          "CreateReplicationSet is deprecated (Nov 7, 2025) and this account is not onboarded to Incident Manager — skipping lifecycle",
        );
        return;
      }
      // The probe unexpectedly onboarded the account (untagged set) — remove
      // it so the alchemy-managed lifecycle below starts from a clean slate.
      yield* incidents.getReplicationSet({ arn: onboarded.success.arn }).pipe(
        Effect.map((r) => r.replicationSet.status),
        Effect.repeat({
          schedule: Schedule.max([
            Schedule.fixed("5 seconds"),
            Schedule.recurs(60),
          ]),
          until: (status) => status !== "CREATING" && status !== "UPDATING",
        }),
      );
      yield* incidents.deleteReplicationSet({ arn: onboarded.success.arn });
      yield* incidents.getReplicationSet({ arn: onboarded.success.arn }).pipe(
        Effect.map((r) => r.replicationSet.status),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("GONE" as const),
        ),
        Effect.repeat({
          schedule: Schedule.max([
            Schedule.fixed("5 seconds"),
            Schedule.recurs(60),
          ]),
          until: (status) => status === "GONE",
        }),
      );

      yield* stack.destroy();

      // Create — onboard Incident Manager in the ambient region.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ReplicationSet("Incidents", {
            tags: { env: "test" },
          });
        }),
      );
      expect(created.arn).toContain(":replication-set/");
      expect(created.status).toBe("ACTIVE");
      expect(created.regionNames).toContain(region);
      expect(created.deletionProtected).toBe(false);

      // Out-of-band verification via distilled.
      const live = yield* incidents.getReplicationSet({ arn: created.arn });
      expect(live.replicationSet.status).toBe("ACTIVE");
      const tags = yield* incidents.listTagsForResource({
        resourceArn: created.arn,
      });
      expect(tags.tags["alchemy::id"]).toBe("Incidents");
      expect(tags.tags["env"]).toBe("test");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(ReplicationSet);
      const all = yield* provider.list();
      expect(all.some((rs) => rs.arn === created.arn)).toBe(true);

      // Update — enable deletion protection + retag, and add a response
      // plan now that the account is onboarded.
      const planName = "alchemy-test-response-plan";
      const { plan } = yield* stack.deploy(
        Effect.gen(function* () {
          const replicationSet = yield* ReplicationSet("Incidents", {
            deletionProtected: true,
            tags: { env: "prod" },
          });
          const plan = yield* ResponsePlan("Critical", {
            name: planName,
            displayName: "Critical incidents",
            incidentTemplate: {
              title: "Critical failure",
              impact: 3,
              summary: "Automated test response plan",
            },
            tags: { fixture: "ssm-incidents" },
          });
          return { replicationSet, plan };
        }),
      );
      expect(plan.arn).toContain(":response-plan/");
      expect(plan.name).toBe(planName);

      const afterUpdate = yield* incidents.getReplicationSet({
        arn: created.arn,
      });
      expect(afterUpdate.replicationSet.deletionProtected).toBe(true);
      const updatedTags = yield* incidents.listTagsForResource({
        resourceArn: created.arn,
      });
      expect(updatedTags.tags["env"]).toBe("prod");

      const livePlan = yield* incidents.getResponsePlan({ arn: plan.arn });
      expect(livePlan.name).toBe(planName);
      expect(livePlan.displayName).toBe("Critical incidents");
      expect(livePlan.incidentTemplate.title).toBe("Critical failure");
      expect(livePlan.incidentTemplate.impact).toBe(3);

      // Update the response plan in place.
      yield* stack.deploy(
        Effect.gen(function* () {
          const replicationSet = yield* ReplicationSet("Incidents", {
            deletionProtected: true,
            tags: { env: "prod" },
          });
          const plan = yield* ResponsePlan("Critical", {
            name: planName,
            displayName: "Critical incidents (updated)",
            incidentTemplate: {
              title: "Critical failure",
              impact: 2,
              summary: "Automated test response plan (updated)",
            },
            tags: { fixture: "ssm-incidents" },
          });
          return { replicationSet, plan };
        }),
      );
      const updatedPlan = yield* incidents.getResponsePlan({ arn: plan.arn });
      expect(updatedPlan.displayName).toBe("Critical incidents (updated)");
      expect(updatedPlan.incidentTemplate.impact).toBe(2);

      // Destroy — the response plan is deleted first, deletion protection is
      // lifted automatically, and Incident Manager is offboarded. The
      // provider's delete waits until the set is fully gone.
      yield* stack.destroy();
      const planError = yield* Effect.flip(
        incidents.getResponsePlan({ arn: plan.arn }),
      );
      expect(planError._tag).toBe("ResourceNotFoundException");
      const after = yield* incidents.listReplicationSets({});
      expect(after.replicationSetArns).toHaveLength(0);
    }),
  // onboarding (~1-2 min) + updates + offboarding (~1-2 min).
  { timeout: 900_000 },
);
