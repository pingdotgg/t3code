import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const EMAIL = "test@alchemy.run";

// The policy an Issues automation notifies. Disabled so the test never
// sends a notification.
const IssuePolicy = Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
  alertType: "workers_observability_real_time_issue",
  enabled: false,
  mechanisms: { email: [{ id: EMAIL }] },
});

test.provider(
  "create, update, delete issue automation",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { policy, automation } = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* IssuePolicy;
          const automation = yield* Cloudflare.Workers.IssueAutomation("Automation", {
            policyId: policy.policyId,
            afterOccurrences: 5,
          });
          return { policy, automation };
        }),
      );

      expect(automation.accountId).toEqual(accountId);
      expect(automation.policyId).toEqual(policy.policyId);
      expect(automation.scope).toEqual("account");
      expect(automation.triggerType).toEqual("occurrence_threshold");
      expect(automation.afterOccurrences).toEqual(5);
      expect(automation.enabled).toBe(true);

      // Verify out-of-band via the API.
      const created = yield* workers.getObservabilityIssueAutomation({
        accountId,
        automationId: automation.automationId,
      });
      expect(created.automation.name).toEqual(automation.name);
      expect(created.automation.ansPolicyId).toEqual(policy.policyId);
      expect(created.automation.threshold).toEqual(5);

      // Redeploying the same props does not write.
      const unchanged = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* IssuePolicy;
          return yield* Cloudflare.Workers.IssueAutomation("Automation", {
            policyId: policy.policyId,
            afterOccurrences: 5,
          });
        }),
      );
      expect(unchanged.revision).toEqual(automation.revision);

      // Switch the trigger, scope it to one Worker, and disable it — all
      // in place, same id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* IssuePolicy;
          return yield* Cloudflare.Workers.IssueAutomation("Automation", {
            policyId: policy.policyId,
            service: "alchemy-issue-automation-worker",
            afterInactivitySeconds: 7200,
            enabled: false,
          });
        }),
      );
      expect(updated.automationId).toEqual(automation.automationId);
      expect(updated.name).toEqual(automation.name);
      expect(updated.scope).toEqual("service");
      expect(updated.service).toEqual("alchemy-issue-automation-worker");
      expect(updated.triggerType).toEqual("recurrence_after_inactivity");
      expect(updated.afterInactivitySeconds).toEqual(7200);
      expect(updated.afterOccurrences).toBeUndefined();
      expect(updated.enabled).toBe(false);

      const afterUpdate = yield* workers.getObservabilityIssueAutomation({
        accountId,
        automationId: automation.automationId,
      });
      expect(afterUpdate.automation.inactivitySeconds).toEqual(7200);
      expect(afterUpdate.automation.threshold).toBeNull();
      expect(afterUpdate.automation.service).toEqual("alchemy-issue-automation-worker");
      expect(afterUpdate.automation.enabled).toBe(false);

      yield* stack.destroy();

      yield* waitForAutomationDeleted(accountId, automation.automationId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
);

test.provider(
  "list enumerates the deployed issue automation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* IssuePolicy;
          return yield* Cloudflare.Workers.IssueAutomation("ListAutomation", {
            policyId: policy.policyId,
            afterOccurrences: 1,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Workers.IssueAutomation);
      const all = yield* provider.list();

      expect(all.some((a) => a.automationId === deployed.automationId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
);

const waitForAutomationDeleted = (accountId: string, automationId: string) =>
  workers.getObservabilityIssueAutomation({ accountId, automationId }).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "AutomationNotDeleted" } as const)),
    Effect.catchTag("ObservabilityIssueAutomationNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "AutomationNotDeleted",
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(10)]),
    }),
  );
