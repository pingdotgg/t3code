import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import { webhookPath } from "@alchemy.run/github/RepositoryEventSource";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Repos from "@distilled.cloud/github/repos";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import GitHubEventSourceWorker, { owner, repository } from "./fixtures/event-source-worker.ts";
import { gh } from "./scope.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
});
const { executeWhenReady, getWhenReady } = Test;

// Public and retained across runs: the gh token lacks delete_repo.
const Repository = GitHub.Repository("Repo", {
  owner,
  name: repository,
  visibility: "public",
  autoInit: true,
});

const listHooks = Effect.gen(function* () {
  return yield* gh(
    Stream.runCollect(Repos.listWebhooks.items({ owner, repo: repository, per_page: 100 })),
  );
});

// Ping the webhook and return the status the Worker answered GitHub with.
const pingStatus = Effect.fn(function* (hookId: number) {
  const pings = gh(Repos.listWebhookDeliveries({ owner, repo: repository, hook_id: hookId })).pipe(
    Effect.map((deliveries) => deliveries.filter((delivery) => delivery.event === "ping")),
  );
  const before = (yield* pings).length;
  yield* gh(Repos.pingWebhook({ owner, repo: repository, hook_id: hookId }));
  // Deliveries are listed newest first.
  const after = yield* pings.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (deliveries) => deliveries.length > before,
      times: 15,
    }),
  );
  return after.length > before ? after[0]!.status_code : undefined;
});

test.provider(
  "consumeRepositoryEvents without a secret verifies every delivery",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // The webhook only depends on the Worker's URL, so the repository has
      // to exist before the Worker deploys.
      yield* stack.deploy(Repository);
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repository;
          const worker = yield* GitHubEventSourceWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      const base = url.replace(/\/+$/, "");
      const deliveryUrl = `${base}${webhookPath({ owner, repository })}`;
      yield* getWhenReady(base);

      // GitHub masks a configured secret as "********" and omits it otherwise.
      const hook = (yield* listHooks).find((hook) => hook.config.url === deliveryUrl);
      const secret = hook?.config.secret;
      expect(Redacted.isRedacted(secret) ? Redacted.value(secret) : secret).toBe("********");

      // An unsigned delivery is rejected.
      const forged = yield* executeWhenReady(
        HttpClientRequest.post(deliveryUrl).pipe(
          HttpClientRequest.setHeader("x-github-event", "push"),
          HttpClientRequest.bodyJsonUnsafe({ ref: "refs/heads/main" }),
        ),
      );
      expect(forged.status).toBe(401);

      // A delivery GitHub signs with the generated secret is accepted. GitHub
      // can reach the fresh workers.dev URL before it serves there (404), so
      // ping again until a delivery gets past the cold start.
      const status = yield* pingStatus(hook!.id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (status) => status !== undefined && status !== 404 && status < 500,
          times: 10,
        }),
      );
      expect(status).toBe(202);

      yield* stack.destroy();
      expect((yield* listHooks).filter((hook) => hook.config.url === deliveryUrl)).toEqual([]);
    }),
  {
    timeout: 180_000,
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:github",
      "provider:github:webhook",
      "live",
    ],
  },
);
