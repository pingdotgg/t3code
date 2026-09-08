import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import EmailCatchAllWorker from "./fixtures/email-catchall-worker.ts";
import EmailTestWorker from "./fixtures/email-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const INBOX = process.env.CLOUDFLARE_TEST_EMAIL_INBOX || `inbox@${ZONE}`;
// The send→receive round trip additionally needs an outbound sender and a
// destination Cloudflare has verified; the deploy-time assertions below do
// not, so only the round trip is gated.
const skipRoundTrip = !process.env.CLOUDFLARE_TEST_EMAIL_FROM;

const Stack = Alchemy.Stack(
  "EmailEventSourceStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* EmailTestWorker;
    return {
      url: worker.url.as<string>(),
      workerName: worker.workerName,
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
const rideOutAuth = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden" || e._tag === "Unauthorized",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${ZONE}" not found in account`));
  }
  return zone.id;
});

// The deploy-time half of the event source: `email({ zone, matchers })`
// yields an `Email.Routing` toggle and an `Email.Rule` whose action targets
// the host Worker. Neither needs mail to flow, so this runs everywhere.
test.provider(
  "subscribe auto-creates Email.Routing and an Email.Rule targeting the worker",
  () =>
    Effect.gen(function* () {
      const { workerName } = yield* stack;
      const zoneId = yield* resolveZoneId;

      const routing = yield* rideOutAuth(
        emailRouting.getEmailRouting({ zoneId }),
      );
      expect(routing.enabled).toBe(true);

      const rules = yield* rideOutAuth(emailRouting.listRules({ zoneId }));
      const ours = (rules.result ?? []).find((rule) =>
        (rule.actions ?? []).some(
          (a) => a.type === "worker" && (a.value ?? []).includes(workerName),
        ),
      );
      expect(ours).toBeDefined();
      expect(ours!.enabled).toBe(true);
      expect(ours!.matchers).toEqual([
        { type: "literal", field: "to", value: INBOX },
      ]);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.skipIf(skipRoundTrip)(
  "deployed worker receives inbound mail routed by the auto-created Email.Rule",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // Reset DO state and double as a readiness probe — fresh workers.dev
    // URLs take a few seconds to start serving 200s.
    yield* Effect.gen(function* () {
      const res = yield* client.post(`${url}/reset`);
      if (res.status !== 200) {
        return yield* Effect.fail(new Error(`Worker not ready: ${res.status}`));
      }
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    const resetAt = Date.now();

    // Send a unique-subject message via the worker's send_email binding.
    const subject = `alchemy email test ${resetAt}`;
    const sendUrl = `${url}/send?subject=${encodeURIComponent(subject)}`;
    yield* Effect.gen(function* () {
      const res = yield* client.post(sendUrl);
      if (res.status !== 200) {
        return yield* Effect.fail(new Error(`/send failed: ${res.status}`));
      }
      const body = (yield* res.json) as { ok: boolean; message?: string };
      if (!body.ok) {
        return yield* Effect.fail(
          new Error(`send_email failed: ${body.message}`),
        );
      }
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 5,
      }),
    );

    // Cloudflare's email pipeline is async — the inbound dispatch typically
    // lands within ~30s but can take longer under load.
    const received = yield* Effect.gen(function* () {
      const res = yield* client.get(`${url}/received`);
      if (res.status !== 200) return [];
      const body = (yield* res.json) as { received?: unknown };
      if (!Array.isArray(body.received)) return [];
      return body.received.filter(
        (r): r is { subject: string | null; receivedAt: number } =>
          typeof r === "object" &&
          r !== null &&
          (r as { subject?: unknown }).subject === subject,
      );
    }).pipe(
      Effect.catch(() => Effect.succeed([])),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (matches) => matches.length > 0,
        times: 48,
      }),
    );

    expect(received.length).toBeGreaterThan(0);
    for (const msg of received) {
      expect(msg.subject).toBe(subject);
      expect(msg.receivedAt).toBeGreaterThanOrEqual(resetAt);
    }
  }).pipe(logLevel),
  { timeout: 360_000 },
);

// The catch-all form: `email({ zone })` with no matchers. Cloudflare
// rejects a lone `{ type: "all" }` matcher on `createRule` with
// "Invalid rule operation", so this stack only deploys at all if the
// event source provisions `Email.CatchAll` instead of `Email.Rule`.
const CatchAllStack = Alchemy.Stack(
  "EmailEventSourceCatchAllStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* EmailCatchAllWorker;
    return { workerName: worker.workerName };
  }),
);

const catchAllStack = beforeAll(deploy(CatchAllStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(CatchAllStack));

test.provider(
  "a catch-all subscription provisions Email.CatchAll, not an Email.Rule",
  () =>
    Effect.gen(function* () {
      const { workerName } = yield* catchAllStack;
      const zoneId = yield* resolveZoneId;

      // The zone's catch-all singleton now points at the worker.
      const catchAll = yield* rideOutAuth(
        emailRouting.getRuleCatchAll({ zoneId }),
      );
      expect(catchAll.enabled).toBe(true);
      expect(catchAll.actions?.[0]?.type).toEqual("worker");
      expect(catchAll.actions?.[0]?.value).toEqual([workerName]);

      // ...and no ordinary rule was created for it. `listRules` surfaces
      // the catch-all too, so exclude it by id rather than by matcher.
      const rules = yield* rideOutAuth(emailRouting.listRules({ zoneId }));
      const strays = (rules.result ?? [])
        .filter((r) => r.id !== catchAll.id)
        .filter((r) =>
          (r.actions ?? []).some(
            (a) => a.type === "worker" && (a.value ?? []).includes(workerName),
          ),
        );
      expect(strays).toEqual([]);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
