import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as alerting from "@distilled.cloud/cloudflare/alerting";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/webhook-receiver.ts");

// Cloudflare fires a test POST at the webhook URL on create/update, so the
// destination worker must be deployed and serving before the webhook
// resource is created.
const Receiver = () =>
  Cloudflare.Worker("WebhookReceiver", {
    main,
    subdomain: { enabled: true },
  });

test.provider("create, update, delete webhook destination", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Phase 1: deploy the receiving worker alone and wait until the
    // workers.dev URL actually serves (fresh subdomains take a few
    // seconds to propagate; the webhook test POST must hit a live 200).
    const receiver = yield* stack.deploy(Receiver());
    expect(receiver.url).toBeDefined();
    yield* expectUrlContains(receiver.url!, "webhook-ok", {
      label: "webhook receiver",
    });

    // Phase 2: create the webhook destination pointing at the worker.
    const webhook = yield* stack.deploy(
      Effect.gen(function* () {
        const worker = yield* Receiver();
        return yield* Cloudflare.Alerting.NotificationWebhook("AlertWebhook", {
          url: worker.url.as<string>(),
        });
      }),
    );

    expect(webhook.webhookId).toBeDefined();
    expect(webhook.accountId).toEqual(accountId);
    expect(webhook.name).toBeDefined();
    expect(webhook.url).toEqual(receiver.url);

    // Verify out-of-band via the API.
    const actual = yield* alerting.getDestinationWebhook({
      accountId,
      webhookId: webhook.webhookId,
    });
    expect(actual.name).toEqual(webhook.name);
    expect(actual.url).toEqual(receiver.url);

    // Phase 3: rename (mutable prop) — same id, new name.
    const renamed = yield* stack.deploy(
      Effect.gen(function* () {
        const worker = yield* Receiver();
        return yield* Cloudflare.Alerting.NotificationWebhook("AlertWebhook", {
          name: "alchemy-test-alerting-webhook-renamed",
          url: worker.url.as<string>(),
        });
      }),
    );
    expect(renamed.webhookId).toEqual(webhook.webhookId);
    expect(renamed.name).toEqual("alchemy-test-alerting-webhook-renamed");

    const afterRename = yield* alerting.getDestinationWebhook({
      accountId,
      webhookId: webhook.webhookId,
    });
    expect(afterRename.name).toEqual("alchemy-test-alerting-webhook-renamed");

    yield* stack.destroy();

    yield* waitForWebhookDeleted(accountId, webhook.webhookId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed webhook destination", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // Deploy the receiving worker, wait for it to serve, then create the
    // webhook destination pointing at it.
    const receiver = yield* stack.deploy(Receiver());
    expect(receiver.url).toBeDefined();
    yield* expectUrlContains(receiver.url!, "webhook-ok", {
      label: "webhook receiver",
    });

    const webhook = yield* stack.deploy(
      Effect.gen(function* () {
        const worker = yield* Receiver();
        return yield* Cloudflare.Alerting.NotificationWebhook("ListWebhook", {
          url: worker.url.as<string>(),
        });
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Alerting.NotificationWebhook,
    );
    const all = yield* provider.list();

    const match = all.find((w) => w.webhookId === webhook.webhookId);
    expect(match).toBeDefined();
    expect(match!.name).toEqual(webhook.name);
    expect(match!.url).toEqual(webhook.url);

    yield* stack.destroy();

    yield* waitForWebhookDeleted(webhook.accountId, webhook.webhookId);
  }).pipe(logLevel),
);

const waitForWebhookDeleted = (accountId: string, webhookId: string) =>
  alerting.getDestinationWebhook({ accountId, webhookId }).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "WebhookNotDeleted" } as const)),
    Effect.catchTag("WebhookNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "WebhookNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );
