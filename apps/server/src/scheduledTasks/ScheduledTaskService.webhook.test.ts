import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

type LaunchInput = ThreadLaunchService.ThreadLaunchInput;

const webhookTaskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:hook",
    title: "Review PRs",
    prompt: "Review this PR: {{body.pull_request.url}}",
    enabled: true,
    schedule: { type: "webhook" },
    projectId: "project-webhook",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

const pullRequestBody = new TextEncoder().encode(
  JSON.stringify({ pull_request: { url: "https://github.com/org/repo/pull/45" } }),
);

const requestFor = (
  task: { readonly id: string; readonly webhook?: { readonly path: string } | undefined },
  overrides: Partial<ScheduledTaskService.WebhookTriggerRequest> = {},
): ScheduledTaskService.WebhookTriggerRequest => ({
  hookId: task.id,
  token: task.webhook?.path.split("/").at(-1) ?? "",
  method: "POST",
  path: `/api/hooks/${task.id}`,
  query: "",
  headers: { "content-type": "application/json" },
  body: pullRequestBody,
  bodyText: new TextDecoder().decode(pullRequestBody),
  ...overrides,
});

/**
 * Runs `body` against a service whose launches are pushed to `launches`;
 * `gate`, when given, holds each launch until the test releases it.
 */
const withService = <A, E>(
  body: (input: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly launches: Queue.Queue<LaunchInput>;
  }) => Effect.Effect<A, E, never>,
  options: { readonly gate?: Deferred.Deferred<void> } = {},
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<LaunchInput>();
    const dependencies = Layer.mergeAll(
      NodePlatformCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Queue.offer(launches, input).pipe(
            Effect.andThen(options.gate ? Deferred.await(options.gate) : Effect.void),
            Effect.as({ threadId: "thread-1", resumed: false } as never),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body({ service, launches });
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory));

it.effect("dispatches exactly the rendered prompt and logs the delivery", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      assert.equal(task.nextRunAt, null);
      assert.isDefined(task.webhook);
      assert.isTrue(task.webhook!.path.startsWith("/api/hooks/scheduled-task%3Ahook/"));
      // Not linked to T3 Connect in tests.
      assert.equal(task.webhook!.url, null);

      const result = yield* service.triggerWebhook(requestFor(task));
      assert.equal(result._tag, "accepted");
      const launched = yield* Queue.take(launches);
      assert.equal(
        launched.initialMessage?.text,
        "Review this PR: https://github.com/org/repo/pull/45",
      );
      assert.equal(
        launched.commandId,
        `scheduled-task:${task.id}:webhook:${result._tag === "accepted" ? result.deliveryId : ""}`,
      );

      const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.outcome, "accepted");
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries[0]!.id,
      });
      assert.equal(delivery.body, new TextDecoder().decode(pullRequestBody));
      assert.equal(delivery.renderedPrompt, launched.initialMessage?.text);
    }),
  ),
);

it.effect("answers not found for a wrong token or unknown hook without logging", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const wrongToken = yield* service.triggerWebhook(requestFor(task, { token: "nope" }));
      assert.equal(wrongToken._tag, "not_found");
      const unknown = yield* service.triggerWebhook(requestFor(task, { hookId: "missing" }));
      assert.equal(unknown._tag, "not_found");
      assert.equal((yield* service.listWebhookDeliveries({ id: task.id })).deliveries.length, 0);
    }),
  ),
);

it.effect("rotating the token retires the old URL and saving keeps it", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const input = yield* webhookTaskInput();
      const { task } = yield* service.upsert(input);
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Renamed" }));
      assert.equal(saved.task.webhook?.path, task.webhook?.path);

      const rotated = yield* service.rotateWebhookToken({ id: task.id });
      assert.notEqual(rotated.task.webhook?.path, task.webhook?.path);
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "not_found");
      assert.equal((yield* service.triggerWebhook(requestFor(rotated.task)))._tag, "accepted");
    }),
  ),
);

it.effect("checks the configured signature and keeps the secret write-only", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: {
              header: "X-Hub-Signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secret: "s3cret",
            },
          },
        }),
      );
      assert.deepEqual(task.schedule, {
        type: "webhook",
        signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
      });
      assert.isTrue(task.webhook?.hasSecret);

      const unsigned = yield* service.triggerWebhook(requestFor(task));
      assert.equal(unsigned._tag, "rejected_signature");

      const signature = `sha256=${NodeCrypto.createHmac("sha256", "s3cret").update(pullRequestBody).digest("hex")}`;
      const signed = yield* service.triggerWebhook(
        requestFor(task, {
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        }),
      );
      assert.equal(signed._tag, "accepted");

      // Saving without a secret keeps the stored one.
      const resaved = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
          },
        }),
      );
      assert.isTrue(resaved.task.webhook?.hasSecret);

      const outcomes = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.map(
        (delivery) => [delivery.outcome, delivery.signatureVerified],
      );
      assert.deepEqual(outcomes.toSorted(), [
        ["accepted", true],
        ["rejected_signature", false],
      ]);
    }),
  ),
);

it.effect("logs but does not run deliveries to a disabled task, and refuses run now", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "disabled");
      assert.equal(yield* Queue.size(launches), 0);
      const runNow = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(runNow.message, "Webhook tasks run when their URL receives a request.");
    }),
  ),
);

it.effect("queues a burst of deliveries instead of dropping them", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* webhookTaskInput());
          const results = yield* Effect.forEach([1, 2, 3], () =>
            service.triggerWebhook(requestFor(task)),
          );
          assert.deepEqual(
            results.map((result) => result._tag),
            ["accepted", "accepted", "accepted"],
          );
          // Only the first is dispatching; the others wait their turn.
          yield* Queue.take(launches);
          yield* Deferred.succeed(gate, undefined);
          const rest = yield* Effect.all([Queue.take(launches), Queue.take(launches)]);
          assert.equal(new Set(rest.map((launch) => launch.commandId)).size, 2);
        }),
      { gate },
    );
  }),
);

it.effect("rate limits a hook past 60 deliveries a minute", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const results = yield* Effect.forEach(Array.from({ length: 61 }), () =>
        service.triggerWebhook(requestFor(task)),
      );
      assert.equal(results.at(-2)?._tag, "disabled");
      assert.equal(results.at(-1)?._tag, "rate_limited");
      // Further rejections in the same window are counted, not logged.
      yield* Effect.forEach([1, 2, 3], () => service.triggerWebhook(requestFor(task)));
      const outcomes = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.map(
        (delivery) => delivery.outcome,
      );
      assert.equal(outcomes.filter((outcome) => outcome === "rate_limited").length, 1);
    }),
  ),
);

it.effect("a save carrying a stale token cannot undo a rotation", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const rotated = yield* service.rotateWebhookToken({ id: task.id });
      // The editor was opened before the rotation and saves afterwards.
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Edited" }));
      assert.equal(saved.task.webhook?.path, rotated.task.webhook?.path);
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "not_found");
    }),
  ),
);

it.effect("keeps the newest 50 deliveries when they share a timestamp", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      // Paused, so each request is logged without starting a run. The test
      // clock is frozen, so every delivery has the same received_at.
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const ids = yield* Effect.forEach(Array.from({ length: 55 }), (_, index) =>
        service.triggerWebhook(requestFor(task, { query: `n=${index}` })).pipe(Effect.as(index)),
      );
      const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
      assert.equal(deliveries.length, 50);
      const first = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries[0]!.id,
      });
      const last = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries.at(-1)!.id,
      });
      assert.equal(first.delivery.query, `n=${ids.at(-1)}`);
      assert.equal(last.delivery.query, "n=5");
    }),
  ),
);

it.effect("keeps credential headers out of the delivery log", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* service.triggerWebhook(
        requestFor(task, {
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sender-token",
            "x-webhook-key": "k",
            "x-github-event": "push",
          },
        }),
      );
      const [summary] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.equal(delivery.headers.authorization, "[redacted]");
      assert.equal(delivery.headers["x-webhook-key"], "[redacted]");
      assert.equal(delivery.headers["x-github-event"], "push");
    }),
  ),
);

const queuedDeliveryCases = [
  {
    change: "paused",
    reason: "The task was paused before this delivery ran.",
    apply: (service: ScheduledTaskService.ScheduledTaskService["Service"], id: string) =>
      service.setEnabled({ id: id as never, enabled: false }),
  },
  {
    change: "switched to an interval trigger",
    reason: "The task's trigger changed before this delivery ran.",
    apply: (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
      webhookTaskInput({ schedule: { type: "interval", everyMs: 3_600_000 } }).pipe(
        Effect.flatMap(service.upsert),
      ),
  },
] as const;

it.effect.each(queuedDeliveryCases)(
  "a delivery queued behind a run does not start once the task is $change",
  ({ reason, apply }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* withService(
        ({ service, launches }) =>
          Effect.gen(function* () {
            const { task } = yield* service.upsert(yield* webhookTaskInput());
            yield* service.triggerWebhook(requestFor(task));
            const queued = yield* service.triggerWebhook(requestFor(task));
            yield* Queue.take(launches);
            yield* apply(service, task.id);
            yield* Deferred.succeed(gate, undefined);
            // The queued delivery is marked failed instead of launching.
            const deliveryId = queued._tag === "accepted" ? queued.deliveryId : undefined;
            let delivery = (yield* service.getWebhookDelivery({
              id: task.id,
              deliveryId: deliveryId!,
            })).delivery;
            while (delivery.outcome === "accepted") {
              yield* Effect.yieldNow;
              delivery = (yield* service.getWebhookDelivery({
                id: task.id,
                deliveryId: deliveryId!,
              })).delivery;
            }
            assert.equal(delivery.outcome, "dispatch_failed");
            assert.equal(delivery.error, reason);
            assert.equal(yield* Queue.size(launches), 0);
          }),
        { gate },
      );
    }),
);

it.effect("a save without a secret keeps a secret changed after it was read", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const signature = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" };
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", signature: { ...signature, secret: "old" } },
        }),
      );
      yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", signature: { ...signature, secret: "new" } },
        }),
      );
      // A form opened before the change saves without sending a secret.
      yield* service.upsert(
        yield* webhookTaskInput({ title: "Edited", schedule: { type: "webhook", signature } }),
      );
      const sign = (secret: string) =>
        `sha256=${NodeCrypto.createHmac("sha256", secret).update(pullRequestBody).digest("hex")}`;
      const withSignature = (secret: string) =>
        requestFor(task, {
          headers: { "content-type": "application/json", "x-hub-signature-256": sign(secret) },
        });
      assert.equal(
        (yield* service.triggerWebhook(withSignature("old")))._tag,
        "rejected_signature",
      );
      assert.equal((yield* service.triggerWebhook(withSignature("new")))._tag, "accepted");
    }),
  ),
);

it.effect("caps deliveries waiting behind a stuck run", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* webhookTaskInput());
          yield* service.triggerWebhook(requestFor(task));
          yield* Queue.take(launches);
          // The cap counts the running delivery too: 19 more wait, the next is refused.
          const waiting = yield* Effect.forEach(Array.from({ length: 20 }), () =>
            service.triggerWebhook(requestFor(task)),
          );
          assert.equal(waiting.filter((result) => result._tag === "accepted").length, 19);
          assert.equal(waiting.at(-1)?._tag, "rate_limited");
          // The refused request is not logged.
          const logged = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
          assert.equal(logged.length, 20);
          yield* Deferred.succeed(gate, undefined);
        }),
      { gate },
    );
  }),
);

it.effect("logs a body's first 64 KiB by bytes, not characters", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      // 30 000 three-byte characters: under 64 Ki characters, over 64 KiB.
      const text = "界".repeat(30_000);
      const body = new TextEncoder().encode(text);
      yield* service.triggerWebhook(requestFor(task, { body, bodyText: text }));
      const [summary] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.isTrue(delivery.bodyTruncated);
      assert.isAtMost(new TextEncoder().encode(delivery.body).byteLength, 64 * 1024 + 3);
    }),
  ),
);

it.effect("deleting a task removes its delivery log", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* service.triggerWebhook(requestFor(task));
      yield* service.delete({ id: task.id });
      assert.equal((yield* service.listWebhookDeliveries({ id: task.id })).deliveries.length, 0);
    }),
  ),
);
