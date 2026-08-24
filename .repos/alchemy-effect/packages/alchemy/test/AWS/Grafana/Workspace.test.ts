import * as AWS from "@/AWS";
import { Workspace } from "@/AWS/Grafana";
import * as Test from "@/Test/Alchemy";
import * as grafana from "@distilled.cloud/aws/grafana";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag the read/delete paths depend on.
test.provider(
  "describeWorkspace on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        grafana.describeWorkspace({ workspaceId: "g-0000000000" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

class WorkspaceStillExists extends Data.TaggedError("WorkspaceStillExists")<{
  readonly workspaceId: string;
}> {}

const assertWorkspaceDeleted = (workspaceId: string) =>
  grafana.describeWorkspace({ workspaceId }).pipe(
    Effect.flatMap((r) =>
      r.workspace.status === "DELETING"
        ? Effect.fail(new WorkspaceStillExists({ workspaceId }))
        : Effect.succeed(undefined),
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
    Effect.retry({
      while: (e) => e._tag === "WorkspaceStillExists",
      schedule: Schedule.max([
        Schedule.spaced("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

// GATED: Grafana workspace provisioning is asynchronous (a few minutes) and
// `AWS_SSO` authentication requires IAM Identity Center to be enabled in the
// account. Run with AWS_TEST_GRAFANA=1 in an entitled account.
test.provider.skipIf(!process.env.AWS_TEST_GRAFANA)(
  "create, update, and destroy a Grafana workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Workspace("Dashboards", {
            name: "alchemy-test-grafana",
            description: "initial",
            accountAccessType: "CURRENT_ACCOUNT",
            authenticationProviders: ["AWS_SSO"],
            permissionType: "SERVICE_MANAGED",
            dataSources: ["PROMETHEUS", "CLOUDWATCH"],
            tags: { Environment: "test" },
          });
        }),
      );

      expect(created.workspaceId).toMatch(/^g-/);
      expect(created.workspaceArn).toContain(":/workspaces/");
      expect(created.status).toBe("ACTIVE");
      expect(created.endpoint).toContain("grafana-workspace");

      const describedWs = yield* grafana.describeWorkspace({
        workspaceId: created.workspaceId,
      });
      expect(describedWs.workspace.tags?.["alchemy::id"]).toBe("Dashboards");

      // Update the description in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Workspace("Dashboards", {
            name: "alchemy-test-grafana",
            description: "updated",
            accountAccessType: "CURRENT_ACCOUNT",
            authenticationProviders: ["AWS_SSO"],
            permissionType: "SERVICE_MANAGED",
            dataSources: ["PROMETHEUS", "CLOUDWATCH"],
            tags: { Environment: "test", Extra: "yes" },
          });
        }),
      );
      expect(updated.workspaceId).toBe(created.workspaceId);

      yield* stack.destroy();
      yield* assertWorkspaceDeleted(created.workspaceId);
    }),
  { timeout: 600_000 },
);
