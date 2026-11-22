import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, UnifiedPushRegistration } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as UnifiedPushDelivery from "./UnifiedPushDelivery.ts";

const NOW = "2026-11-22T12:00:00.000Z";
const ENVIRONMENT_ID = EnvironmentId.make("push-environment");
const THREAD_ID = ThreadId.make("push-thread");
const PHONE = { deviceId: "phone", endpoint: "https://push.example/up/phone" };
const decodeStored = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(UnifiedPushRegistration)),
);

const state = (phase: RelayAgentActivityState["phase"]): RelayAgentActivityState => ({
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  projectTitle: "Project",
  threadTitle: "Thread",
  phase,
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: NOW,
  deepLink: `/threads/${ENVIRONMENT_ID}/${THREAD_ID}`,
});

interface Post {
  readonly url: string;
  readonly contentEncoding: string | undefined;
  readonly body: Uint8Array;
  readonly data: () => Record<string, string>;
}

const makeHarness = Effect.fnUntraced(function* (statusFor: (url: string) => number = () => 201) {
  const values = new Map<string, Uint8Array>();
  const saves = yield* Queue.unbounded<string>();
  const failures = { remaining: 0 };
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) =>
      failures.remaining > 0
        ? Effect.suspend(() => {
            failures.remaining -= 1;
            return Effect.fail(
              new ServerSecretStore.SecretStorePersistError({ resource: name, cause: "disk full" }),
            );
          })
        : Effect.sync(() => {
            values.set(name, value);
            Queue.offerUnsafe(saves, name);
          }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  });
  const posts = yield* Queue.unbounded<Post>();
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      Queue.offerUnsafe(posts, {
        url: request.url,
        contentEncoding: request.headers["content-encoding"],
        body,
        data: () => JSON.parse(new TextDecoder().decode(body)),
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: statusFor(request.url) }),
      );
    }),
  );
  const layer = UnifiedPushDelivery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore.ServerSecretStore, secrets),
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
        }),
      ),
    ),
  );
  const storedDeviceIds = () => {
    const stored = values.get(UnifiedPushDelivery.UNIFIED_PUSH_REGISTRATIONS_SECRET);
    return stored === undefined
      ? []
      : decodeStored(new TextDecoder().decode(stored)).map(({ deviceId }) => deviceId);
  };
  // Each call builds a fresh service instance over the same secret store.
  const withService = <A, E>(
    use: (service: UnifiedPushDelivery.UnifiedPushDelivery["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      return yield* use(yield* UnifiedPushDelivery.UnifiedPushDelivery);
    }).pipe(Effect.provide(layer));
  return { posts, saves, failures, storedDeviceIds, withService };
});

describe("UnifiedPushDelivery", () => {
  it.effect("sends the current card on register and keeps registrations across restarts", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const { posts, storedDeviceIds, withService } = yield* makeHarness();

      yield* withService((service) =>
        Effect.gen(function* () {
          const invalid = yield* service
            .register({ deviceId: "phone", endpoint: "file:///etc/passwd" })
            .pipe(Effect.flip);
          assert.equal(invalid._tag, "UnifiedPushEndpointError");

          yield* service.publish(THREAD_ID, state("running"));
          yield* service.register(PHONE);
          const card = yield* Queue.take(posts);
          assert.equal(card.url, PHONE.endpoint);
          assert.equal(card.contentEncoding, undefined);
          assert.include(card.data(), {
            t3_kind: "agent_activity",
            device_id: "phone",
            user_id: "unifiedpush",
            source: ENVIRONMENT_ID,
            active: "true",
            activity_active_count: "1",
          });
          assert.notProperty(card.data(), "alert_id");
        }),
      );
      assert.deepEqual(storedDeviceIds(), ["phone"]);

      yield* withService((service) =>
        Effect.gen(function* () {
          yield* service.publish(THREAD_ID, state("waiting_for_approval"));
          // The same phase again changes nothing, so the next post is the completion.
          yield* service.publish(THREAD_ID, state("waiting_for_approval"));
          yield* service.publish(THREAD_ID, state("completed"));
          const approval = (yield* Queue.take(posts)).data();
          assert.include(approval, {
            device_id: "phone",
            source: ENVIRONMENT_ID,
            activity_phase: "waiting_for_approval",
            alert_title: "Thread",
            alert_body: "Approval: Project",
            alert_path: `/threads/${ENVIRONMENT_ID}/${THREAD_ID}`,
          });
          const completed = (yield* Queue.take(posts)).data();
          assert.include(completed, { active: "false", activity_phase: "completed" });
          assert.isDefined(completed.alert_id);
        }),
      );
    }),
  );

  it.effect("encrypts pushes for a registration with keys", () =>
    Effect.gen(function* () {
      const { posts, withService } = yield* makeHarness();
      const receiver = yield* Effect.promise(() =>
        crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
      );
      const raw = new Uint8Array(
        yield* Effect.promise(() => crypto.subtle.exportKey("raw", receiver.publicKey)),
      );
      const base64Url = (bytes: Uint8Array) =>
        btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      yield* withService((service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...PHONE,
            keys: {
              p256dh: base64Url(raw),
              auth: base64Url(crypto.getRandomValues(new Uint8Array(16))),
            },
          });
          const post = yield* Queue.take(posts);
          assert.equal(post.contentEncoding, "aes128gcm");
          assert.notInclude(new TextDecoder().decode(post.body), "agent_activity");
        }),
      );
    }),
  );

  it.effect("drops a registration whose endpoint is gone, and on unregister", () =>
    Effect.gen(function* () {
      const gone = "https://push.example/up/gone";
      const { saves, storedDeviceIds, withService } = yield* makeHarness((url) =>
        url === gone ? 410 : 201,
      );
      yield* withService((service) =>
        Effect.gen(function* () {
          yield* service.register({ deviceId: "tablet", endpoint: gone });
          yield* service.register(PHONE);
          // Two registration saves, then the tablet's first card meets the 410 and saves again.
          yield* Queue.take(saves);
          yield* Queue.take(saves);
          yield* Queue.take(saves);
          assert.deepEqual(storedDeviceIds(), ["phone"]);

          yield* service.unregister("phone");
          yield* Queue.take(saves);
          assert.deepEqual(storedDeviceIds(), []);
        }),
      );
    }),
  );

  it.effect("keeps an unregister durable when retried after a failed save", () =>
    Effect.gen(function* () {
      const { saves, failures, storedDeviceIds, withService } = yield* makeHarness();
      yield* withService((service) =>
        Effect.gen(function* () {
          yield* service.register(PHONE);
          yield* Queue.take(saves);
          failures.remaining = 1;
          const failed = yield* Effect.exit(service.unregister("phone"));
          assert.isTrue(failed._tag === "Failure");
          assert.deepEqual(storedDeviceIds(), ["phone"]);
          yield* service.unregister("phone");
          yield* Queue.take(saves);
        }),
      );
      assert.deepEqual(storedDeviceIds(), []);
      // A restart reads the durable list, so the phone stays unregistered.
      yield* withService(() => Effect.void);
      assert.deepEqual(storedDeviceIds(), []);
    }),
  );
});
