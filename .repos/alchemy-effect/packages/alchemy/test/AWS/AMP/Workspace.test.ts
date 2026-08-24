import * as AWS from "@/AWS";
import {
  AlertManagerDefinition,
  RuleGroupsNamespace,
  Workspace,
} from "@/AWS/AMP";
import * as Test from "@/Test/Alchemy";
import * as amp from "@distilled.cloud/aws/amp";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const RULES_V1 = `groups:
  - name: example
    rules:
      - record: metric:requests:rate5m
        expr: rate(http_requests_total[5m])`;

const RULES_V2 = `groups:
  - name: example
    rules:
      - record: metric:requests:rate10m
        expr: rate(http_requests_total[10m])`;

const ALERTS = `alertmanager_config: |
  route:
    receiver: default
  receivers:
    - name: default`;

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

class WorkspaceStillExists extends Data.TaggedError("WorkspaceStillExists")<{
  readonly workspaceId: string;
}> {}

const assertWorkspaceDeleted = (workspaceId: string) =>
  amp.describeWorkspace({ workspaceId }).pipe(
    Effect.flatMap((r) =>
      r.workspace.status.statusCode === "DELETING"
        ? Effect.fail(new WorkspaceStillExists({ workspaceId }))
        : Effect.succeed(undefined),
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
    Effect.retry({
      while: (e) => e._tag === "WorkspaceStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag the read/delete paths depend on.
test.provider(
  "describeWorkspace on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        amp.describeWorkspace({
          workspaceId: "ws-00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// AMP workspaces + rule/alert sub-resources are cheap and quick to
// provision, so the full lifecycle runs ungated.
test.provider(
  "create, update, and destroy a workspace with rules and alerts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create the workspace + a rule groups namespace + alert manager def.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const workspace = yield* Workspace("Metrics", {
            alias: "alchemy-test-amp",
            tags: { Environment: "test" },
          });
          const rules = yield* RuleGroupsNamespace("Rules", {
            workspaceId: workspace.workspaceId,
            name: "alchemy-test-rules",
            definition: RULES_V1,
            tags: { Environment: "test" },
          });
          const alerts = yield* AlertManagerDefinition("Alerts", {
            workspaceId: workspace.workspaceId,
            definition: ALERTS,
          });
          return { workspace, rules, alerts };
        }),
      );

      const workspaceId = created.workspace.workspaceId;
      expect(workspaceId).toMatch(/^ws-/);
      expect(created.workspace.workspaceArn).toContain(":workspace/");
      expect(created.workspace.status).toBe("ACTIVE");
      expect(created.workspace.prometheusEndpoint).toContain("aps-workspaces");
      expect(created.rules.ruleGroupsNamespaceArn).toContain(
        ":rulegroupsnamespace/",
      );
      expect(created.alerts.workspaceId).toBe(workspaceId);

      // Out-of-band verification via distilled.
      const describedWs = yield* amp.describeWorkspace({ workspaceId });
      expect(describedWs.workspace.alias).toBe("alchemy-test-amp");
      expect(describedWs.workspace.tags?.["alchemy::id"]).toBe("Metrics");

      const describedRules = yield* amp.describeRuleGroupsNamespace({
        workspaceId,
        name: "alchemy-test-rules",
      });
      expect(describedRules.ruleGroupsNamespace.data).toBeDefined();
      expect(decode(describedRules.ruleGroupsNamespace.data!)).toBe(RULES_V1);
      expect(describedRules.ruleGroupsNamespace.tags?.["alchemy::id"]).toBe(
        "Rules",
      );

      // The workspace Alertmanager provisions asynchronously (a few
      // minutes); the definition exists immediately but its `data` blob is
      // only returned once ACTIVE.
      const describedAlerts = yield* amp.describeAlertManagerDefinition({
        workspaceId,
      });
      expect(
        ["ACTIVE", "CREATING"].includes(
          describedAlerts.alertManagerDefinition.status.statusCode,
        ),
      ).toBe(true);
      if (describedAlerts.alertManagerDefinition.data !== undefined) {
        expect(decode(describedAlerts.alertManagerDefinition.data)).toBe(
          ALERTS,
        );
      }

      // Update: change the alias and the rules definition in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const workspace = yield* Workspace("Metrics", {
            alias: "alchemy-test-amp-v2",
            tags: { Environment: "test", Extra: "yes" },
          });
          const rules = yield* RuleGroupsNamespace("Rules", {
            workspaceId: workspace.workspaceId,
            name: "alchemy-test-rules",
            definition: RULES_V2,
            tags: { Environment: "test" },
          });
          const alerts = yield* AlertManagerDefinition("Alerts", {
            workspaceId: workspace.workspaceId,
            definition: ALERTS,
          });
          return { workspace, rules, alerts };
        }),
      );

      // Stable identifiers survive the in-place update.
      expect(updated.workspace.workspaceId).toBe(workspaceId);
      expect(updated.workspace.workspaceArn).toBe(
        created.workspace.workspaceArn,
      );
      expect(updated.rules.ruleGroupsNamespaceArn).toBe(
        created.rules.ruleGroupsNamespaceArn,
      );

      const afterWs = yield* amp.describeWorkspace({ workspaceId });
      expect(afterWs.workspace.alias).toBe("alchemy-test-amp-v2");
      expect(afterWs.workspace.tags?.Extra).toBe("yes");

      const afterRules = yield* amp.describeRuleGroupsNamespace({
        workspaceId,
        name: "alchemy-test-rules",
      });
      expect(afterRules.ruleGroupsNamespace.data).toBeDefined();
      expect(decode(afterRules.ruleGroupsNamespace.data!)).toBe(RULES_V2);

      yield* stack.destroy();
      yield* assertWorkspaceDeleted(workspaceId);
    }),
  { timeout: 240_000 },
);
