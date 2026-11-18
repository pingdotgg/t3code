import * as Cloudflare from "@alchemy.run/cloudflare";
import { notificationPath } from "@alchemy.run/cloudflare/Alerting/NotificationEventSource";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as alerting from "@distilled.cloud/cloudflare/alerting";
import * as Issues from "@distilled.cloud/github/issues";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import NotificationWorker, {
  IssuePolicy,
  owner,
  Repo,
  repository,
} from "./fixtures/notification-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
});
const { executeWhenReady, getWhenReady } = Test;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const Stack = Effect.gen(function* () {
  yield* Repo;
  const policy = yield* IssuePolicy;
  const worker = yield* NotificationWorker;
  yield* Cloudflare.Workers.IssueAutomation("BoomIssues", {
    policyId: policy.policyId,
    service: worker.workerName,
    afterOccurrences: 1,
  });
  return {
    policyId: policy.policyId,
    workerName: worker.workerName,
    url: worker.url.as<string>(),
  };
});

// Open issues the Worker opened about itself since `since`. The Worker's name
// is stable across runs, so the creation time singles out this run's issues.
const issuesFor = (workerName: string, since: string) =>
  Effect.gen(function* () {
    const issues = yield* Issues.listForRepo({ owner, repo: repository, state: "open", since });
    return issues.filter(
      (issue) =>
        !issue.pull_request && issue.created_at >= since && issue.title.includes(workerName),
    );
  });

test.provider(
  "consumeNotifications opens a GitHub issue for a Workers issue",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const since = new Date().toISOString();
      const { policyId, workerName, url } = yield* stack.deploy(Stack);
      const base = url.replace(/\/+$/, "");
      const deliveryUrl = `${base}${notificationPath({ LogicalId: "IssuePolicy" })}`;

      // The event source bound a webhook destination at the Worker onto a
      // policy declared without mechanisms. Cloudflare only creates a
      // destination whose test message the Worker acknowledged.
      const policy = yield* alerting.getPolicy({ accountId, policyId });
      const webhookIds = (policy.mechanisms?.webhooks ?? []).map((w) => w.id);
      expect(webhookIds).toHaveLength(1);
      const webhook = yield* alerting.getDestinationWebhook({
        accountId,
        webhookId: webhookIds[0]!,
      });
      expect(webhook.url).toEqual(deliveryUrl);

      // A delivery without the secret is rejected.
      yield* getWhenReady(base);
      const forged = yield* executeWhenReady(
        HttpClientRequest.post(deliveryUrl).pipe(
          HttpClientRequest.setHeader("cf-webhook-auth", "not-the-secret"),
          HttpClientRequest.bodyJsonUnsafe({ alert_type: "workers_observability_real_time_issue" }),
        ),
      );
      expect(forged.status).toBe(401);

      // A 5xx response is a Workers issue occurrence. The automation notifies
      // the policy, Cloudflare delivers to the Worker, and the Worker opens a
      // GitHub issue through the `GitHub.CreateIssue` binding.
      const client = yield* HttpClient.HttpClient;
      yield* Effect.forEach([1, 2, 3], () => client.get(`${base}/boom`), { discard: true });

      const issues = yield* issuesFor(workerName, since).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (issues) => issues.length > 0,
          times: 18,
        }),
      );
      expect(issues.length).toBeGreaterThan(0);
      // Titled with the summary line, with Cloudflare's report as the body.
      expect(issues[0]!.title).toMatch(/^Real-Time Issue '.*' detected in /);
      expect(issues[0]!.body).toContain(`/workers/services/view/${workerName}/production/issues/`);

      // The fixture repository is retained across runs: close this run's issues.
      yield* Effect.forEach(
        issues,
        (issue) =>
          Issues.update({
            owner,
            repo: repository,
            issue_number: issue.number,
            state: "closed",
          }),
        { discard: true },
      );

      yield* stack.destroy();
      yield* alerting.getDestinationWebhook({ accountId, webhookId: webhookIds[0]! }).pipe(
        Effect.flatMap(() => Effect.fail({ _tag: "StillExists" as const })),
        Effect.catchTag("WebhookNotFound", () => Effect.void),
        Effect.retry({
          while: (e) => e._tag === "StillExists",
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );
    }).pipe(logLevel),
  {
    timeout: 180_000,
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:alerting",
      "provider:cloudflare:worker",
      "provider:github",
      "live",
    ],
  },
);
