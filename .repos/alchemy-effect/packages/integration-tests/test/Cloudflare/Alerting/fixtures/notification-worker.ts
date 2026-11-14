import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const owner = "alchemy-run-test";
export const repository = "alchemy-pr-2519-notifications";

// Public and retained across runs: the gh token lacks delete_repo.
export const Repo = GitHub.Repository("Repo", {
  owner,
  name: repository,
  visibility: "public",
  description: "Retained deterministic fixture for alchemy PR #2519 (Cloudflare notifications)",
  autoInit: true,
});

// Declares no mechanisms: the Worker's event source adds its webhook.
export const IssuePolicy = Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
  alertType: "workers_observability_real_time_issue",
});

// Opens a GitHub issue for every notification of the policy an Issues
// automation scoped to this Worker notifies, so `/boom` makes Cloudflare report
// the Worker's own error to GitHub.
export default class NotificationWorker extends Cloudflare.Worker<NotificationWorker>()(
  "NotificationWorker",
  {
    main: import.meta.url,
    observability: { enabled: true, issues: { enabled: true } },
  },
  Effect.gen(function* () {
    const policy = yield* IssuePolicy;
    const createIssue = yield* GitHub.CreateIssue(yield* Repo);

    yield* Cloudflare.Alerting.consumeNotifications(policy, (notification) =>
      createIssue({
        title: notification.text.split("\n")[0],
        body: notification.text,
      }).pipe(Effect.orDie),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (new URL(request.url, "http://x").pathname === "/boom") {
          return yield* Effect.die(new Error("alchemy notification event source test"));
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Alerting.NotificationEventSourceLive, GitHub.CreateIssueHttp),
    ),
  ),
) {}
