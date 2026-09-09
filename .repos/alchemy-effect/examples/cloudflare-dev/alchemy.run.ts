import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Counter, QueueMessages } from "./src/AsyncWorker.ts";
import EffectWorker from "./src/EffectWorker.ts";
import HyperdriveWorker from "./src/HyperdriveWorker.ts";
import { SandboxLive } from "./src/SandboxContainer.ts";

export type AsyncWorkerEnv = Cloudflare.InferEnv<
  ReturnType<typeof AsyncWorker>
>;

/**
 * Value the Secrets Store secret is seeded with. The integ test asserts the
 * exact value round-trips through the `secrets_store_secret` binding.
 */
export const SECRETS_STORE_VALUE = "store-secret-abc123";

/**
 * Hyperdrive needs a reachable Postgres origin even in local dev (the local
 * provider is a passthrough to the `dev` origin, not a SQL simulator). Set
 * e.g. `HYPERDRIVE_DEV_URL=postgres://user:pass@localhost:5432/postgres` to
 * include the HyperdriveWorker in the stack; without it the resource is
 * omitted and the integ test skips.
 */
export const HYPERDRIVE_DEV_URL = process.env.HYPERDRIVE_DEV_URL;

/**
 * Tail consumer: listed in AsyncWorker's `tailConsumers`, it receives a trace
 * batch for every AsyncWorker invocation and records them into a KV
 * namespace, exposed over `GET /events`.
 */
const TailWorker = Effect.gen(function* () {
  const events = yield* Cloudflare.KV.Namespace("TailEvents");
  return yield* Cloudflare.Worker("TailWorker", {
    main: "./src/TailWorker.ts",
    env: {
      EVENTS: events,
    },
  });
});

const AsyncWorker = (deps: {
  tailWorker: Cloudflare.Worker;
  liveKv: Cloudflare.KV.Namespace;
}) =>
  Effect.gen(function* () {
    const queue = yield* Cloudflare.Queues.Queue("AsyncWorkerQueue");
    const bucket = yield* Cloudflare.R2.Bucket("AsyncWorkerBucket", {
      forceDestroy: true,
    });
    const db = yield* Cloudflare.D1.Database("AsyncWorkerDB", {
      // Applied on deploy — including local dev, where they run against the
      // local D1 simulator through an ephemeral workerd gateway.
      migrations: "./migrations",
    });
    const worker = yield* Cloudflare.Worker("AsyncWorker", {
      main: "./src/AsyncWorker.ts",
      assets: {
        directory: "./assets",
        runWorkerFirst: true,
      },
      // Every invocation of this worker delivers a trace batch (console
      // logs, outcome) to the tail worker.
      tailConsumers: [deps.tailWorker],
      env: {
        COUNTER: Cloudflare.DurableObject<Counter>("Counter", {
          className: "Counter",
        }),
        QUEUE: queue,
        BUCKET: bucket,
        DB: db,
        MESSAGES: Cloudflare.DurableObject<QueueMessages>("QueueMessages", {
          className: "QueueMessages",
        }),
        MY_VARIABLE: "my-variable-abc123",
        MY_SECRET: Config.redacted("MY_SECRET").pipe(
          Config.withDefault(Redacted.make("my-secret-abc123")),
        ),
        // The worker's own URL, injected as a plain-text binding (`self_url`).
        PUBLIC_URL: Cloudflare.Worker.URL,
        // Rate limit binding — a Worker-only binding with no backing cloud
        // resource; fully emulated (real throttling) in local dev.
        THROTTLE: Cloudflare.RateLimit("THROTTLE", {
          namespaceId: 1001,
          simple: { limit: 2, period: 10 },
        }),
        // Version metadata — locally stubbed with a random `id`.
        CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
        // Service binding to the Effect-native worker (worker → worker call).
        SERVICE: EffectWorker,
        // Hybrid: this KV namespace opted out of local emulation via
        // `Alchemy.remote()` — the local worker proxies to the REAL namespace.
        LIVE_KV: deps.liveKv,
      },
    });
    yield* Cloudflare.Queues.Consumer("Consumer", {
      queueId: queue.queueId,
      scriptName: worker.workerName,
    });
    return worker;
  });

/**
 * Media & messaging worker: Browser Rendering, Images, Stream, Secrets
 * Store, and Email (send + inbound handler) — all served by local
 * simulators under `alchemy dev`. `IMAGES_REMOTE` demonstrates the per-
 * binding hybrid escape hatch: piping the binding through
 * `Alchemy.remote()` proxies just that binding to the real Images service
 * while the worker stays local.
 */
const MediaWorker = Effect.gen(function* () {
  const store = yield* Cloudflare.SecretsStore.Store("Secrets");
  const apiKey = yield* Cloudflare.SecretsStore.Secret("ApiKey", {
    store,
    value: Redacted.make(SECRETS_STORE_VALUE),
  });
  const email = yield* Cloudflare.Email.SendEmail("Notifications", {
    allowedDestinationAddresses: ["allowed@example.com"],
  });
  const worker = yield* Cloudflare.Worker("MediaWorker", {
    main: "./src/MediaWorker.ts",
    compatibility: { flags: ["nodejs_compat"] },
    env: {
      BROWSER: Cloudflare.Browser("BROWSER"),
      IMAGES: Cloudflare.Images.Images("IMAGES"),
      IMAGES_REMOTE: Cloudflare.Images.Images("IMAGES_REMOTE").pipe(
        Alchemy.remote(),
      ),
      STREAM: Cloudflare.Stream.Stream("STREAM"),
      EMAIL: email,
      API_KEY: apiKey,
    },
  });
  return { worker, store, apiKey };
});

/**
 * Inbound email worker: exposes an `email()` handler driven locally via
 * `POST /cdn-cgi/handler/email`. Kept on its own worker — see the note in
 * src/InboxWorker.ts for why it must not share a worker with images/stream
 * bindings in local dev.
 */
const InboxWorker = Effect.gen(function* () {
  const inbox = yield* Cloudflare.KV.Namespace("Inbox");
  return yield* Cloudflare.Worker("InboxWorker", {
    main: "./src/InboxWorker.ts",
    env: {
      INBOX: inbox,
    },
  });
});

export default Alchemy.Stack(
  "CloudflareDev",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const tailWorker = yield* TailWorker;
    const liveKv = yield* Cloudflare.KV.Namespace("LiveKV").pipe(
      Alchemy.remote(),
    );
    const asyncWorker = yield* AsyncWorker({ tailWorker, liveKv });
    const effectWorker = yield* EffectWorker;
    const media = yield* MediaWorker;
    const inboxWorker = yield* InboxWorker;
    const hyperdrive = HYPERDRIVE_DEV_URL ? yield* HyperdriveWorker : undefined;

    return {
      asyncWorker: asyncWorker.url,
      effectWorker: effectWorker.url,
      mediaWorker: media.worker.url,
      tailWorker: tailWorker.url,
      inboxWorker: inboxWorker.url,
      // `dev:`-prefixed ids mean "locally emulated"; LiveKV must NOT carry
      // one (it's a real cloud namespace, even during dev).
      liveKvNamespaceId: liveKv.namespaceId,
      secretsStoreId: media.store.storeId,
      secretsSecretId: media.apiKey.secretId,
      ...(hyperdrive ? { hyperdrive: hyperdrive.url } : {}),
    };
  }).pipe(Effect.provide(SandboxLive)),
);
