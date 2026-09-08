import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { generateLocalId, isLiveId } from "@/Cloudflare/LocalRuntime";
import * as Provider from "@/Provider";
import { poll } from "@/Util/poll.ts";
import { State } from "@/State";
import type { CreatedResourceState } from "@/State/ResourceState";
import * as Test from "@/Test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ConsumerWorker from "./fixtures/dedicated-consumer-worker.ts";
import ProducerWorker from "./fixtures/dedicated-producer-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const TEST_STAGE = "test";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Seed a `created` Queue state row whose `queueId` is a `dev:` mock id —
 * i.e. the shape `alchemy dev` persists when a queue is "created" locally
 * against the in-memory local runtime instead of Cloudflare. Dev runs stamp
 * `providerMode: "local"` on every commit, so the seeded row carries it.
 */
const seedDevQueue = (input: {
  stackName: string;
  fqn: string;
  queueId: string;
  queueName: string;
  accountId: string;
}) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    yield* state.set({
      stack: input.stackName,
      stage: TEST_STAGE,
      fqn: input.fqn,
      value: {
        kind: "resource",
        status: "created",
        resourceType: "Cloudflare.Queues.Queue",
        namespace: undefined,
        fqn: input.fqn,
        logicalId: input.fqn,
        instanceId: "00000000000000000000000000000001",
        providerVersion: 0,
        providerMode: "local",
        bindings: [],
        downstream: [],
        props: {},
        attr: {
          queueId: input.queueId,
          queueName: input.queueName,
          accountId: input.accountId,
        },
      } satisfies CreatedResourceState,
    });
  });

/**
 * Promotion: a queue that was "created" in dev (its persisted `queueId`
 * is a `dev:` mock id) must be promoted to a real Cloudflare queue on the
 * first live deploy.
 *
 * The row is stamped `providerMode: "local"`, which differs from the
 * deploy's resolved mode (`live`), so the engine plans a REPLACEMENT: the
 * live provider creates a real queue and the old local-mode generation is
 * deleted via the local provider (no cloud call for the `dev:` id). The
 * resulting `queueId` must be a live id and resolvable on Cloudflare.
 */
test.provider("promotes a dev queue to a live queue on deploy", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const devQueueId = generateLocalId();
    yield* seedDevQueue({
      stackName: stack.name,
      fqn: "Q",
      queueId: devQueueId,
      queueName: "dev-placeholder-name",
      accountId,
    });

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queues.Queue("Q");
        return { queue };
      }),
    );

    // The dev id has been replaced with a real Cloudflare queue id.
    expect(isLiveId(deployed.queue.queueId)).toBe(true);
    expect(deployed.queue.queueId).not.toEqual(devQueueId);

    // The promoted queue is a real, resolvable Cloudflare resource. A
    // brand-new queue can briefly 404 from this out-of-band read under load,
    // so ride out the read-after-create lag before asserting.
    const live = yield* queues
      .getQueue({
        accountId,
        queueId: deployed.queue.queueId,
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "QueueNotFound",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );
    expect(live.queueId).toEqual(deployed.queue.queueId);

    // And the persisted state now carries the live id, not the dev one.
    const persisted = yield* Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.get({
        stack: stack.name,
        stage: TEST_STAGE,
        fqn: "Q",
      });
    });
    expect((persisted as any)?.attr?.queueId).toEqual(deployed.queue.queueId);

    yield* stack.destroy();

    // After destroy the promoted (live) queue is gone on Cloudflare.
    const exit = yield* Effect.exit(
      queues.getQueue({ accountId, queueId: deployed.queue.queueId }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }).pipe(logLevel),
);

// Canonical `list()` test (account-scoped collection): deploy a real
// queue, resolve the provider from context via `findProvider`, call
// `list()`, and assert the deployed queue appears in the exhaustively-
// paginated result.
test.provider("list enumerates the deployed queue", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Queues.Queue("ListQueue");
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Queues.Queue);

    // A just-created queue can lag the account-wide list under load — poll
    // until it shows up (bounded) instead of asserting on the first read.
    const all = yield* poll({
      description: "list() includes the deployed queue",
      effect: provider.list(),
      predicate: (all) => all.some((q) => q.queueId === deployed.queueId),
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(20),
      ]),
    });

    expect(all.some((q) => q.queueId === deployed.queueId)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

/**
 * Suppressed delete: a queue that only ever existed in dev (its
 * persisted `queueId` is a `dev:` mock id) has no Cloudflare counterpart.
 * Destroying it must NOT issue a `deleteQueue` against Cloudflare — the
 * `dev:` id is not a valid queue id and the request URL would be
 * malformed. The row is stamped `providerMode: "local"`, so the engine
 * resolves the LOCAL provider's `delete` for it (an in-memory registry
 * removal), and destroy succeeds with the state row removed cleanly.
 */
test.provider("suppresses deletion of a dev-only queue", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const devQueueId = generateLocalId();
    yield* seedDevQueue({
      stackName: stack.name,
      fqn: "Q",
      queueId: devQueueId,
      queueName: "dev-placeholder-name",
      accountId,
    });

    // Destroy must not attempt a (malformed) live delete against the dev id.
    const exit = yield* Effect.exit(stack.destroy());
    expect(Exit.isSuccess(exit)).toBe(true);

    // The dev-only resource is removed from state.
    const persisted = yield* Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.get({
        stack: stack.name,
        stage: TEST_STAGE,
        fqn: "Q",
      });
    });
    expect(persisted).toBeUndefined();
  }).pipe(logLevel),
);

/**
 * Regression test for #1243 — producer and consumer split across two
 * Workers, so the consuming Worker has no producer binding and learns its
 * queue's name only from the `DedicatedQueue_queueName` env binding.
 *
 * Before the `packEnvValue` fix, that binding deployed as the JSON-packed
 * `"the-name"` (quote characters on the wire): the raw-binding assertion
 * below failed, and any consumer of the raw value — including the
 * reporter's — could never match Cloudflare's bare `MessageBatch.queue`.
 * The test pins both halves: the binding is the bare name, and the
 * handler receives the message end-to-end.
 */
test.provider.skipIf(!!process.env.FAST)(
  "dedicated consumer worker deploys a bare queue-name binding and receives messages",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const producer = yield* ProducerWorker;
          const consumer = yield* ConsumerWorker;
          return {
            producer: producer.url.as<string>(),
            consumer: consumer.url.as<string>(),
          };
        }),
      );

      const client = yield* HttpClient.HttpClient;
      // Fresh workers.dev URLs 404 for a few seconds; retry through it.
      const get = (url: string) =>
        client.get(url).pipe(
          Effect.flatMap((res) =>
            res.status < 300
              ? Effect.succeed(res)
              : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.min([
                Schedule.exponential("500 millis"),
                Schedule.spaced("3 seconds"),
              ]),
              Schedule.recurs(30),
            ]),
          }),
          Effect.orDie,
        );

      // The raw env binding is the bare queue name — no quote characters
      // on the wire (#1243: it deployed as `"the-name"`).
      const binding = (yield* (yield* get(`${out.consumer}/binding`)).json) as {
        queueName: string;
      };
      expect(binding.queueName).not.toMatch(/^"/);
      expect(binding.queueName).toMatch(/queue/);

      yield* get(`${out.producer}/send?text=dedicated`);

      const received = yield* get(`${out.consumer}/received`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => (body as { bodies?: string[] })?.bodies ?? []),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (bodies) => bodies.includes("dedicated"),
          times: 45,
        }),
        Effect.orDie,
      );
      expect(received).toContain("dedicated");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
