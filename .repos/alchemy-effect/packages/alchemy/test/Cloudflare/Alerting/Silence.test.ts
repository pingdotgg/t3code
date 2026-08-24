import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as alerting from "@distilled.cloud/cloudflare/alerting";
import { expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const EMAIL = "test@alchemy.run";

const DAY_MS = 86_400_000;

// Cloudflare rejects silence windows starting more than 90 days out, so the
// window cannot be a fixed far-future constant. Derive it from the Effect
// Clock, truncated to the UTC day boundary: deterministic within a test run
// (and across reruns on the same day), always inside the 90-day limit.
const silenceWindow = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.sync(() => {
    const base = Math.floor(now / DAY_MS) * DAY_MS;
    return {
      start: new Date(base + 30 * DAY_MS).toISOString(),
      end: new Date(base + 31 * DAY_MS).toISOString(),
      extendedEnd: new Date(base + 32 * DAY_MS).toISOString(),
    };
  });
});

const sameInstant = (a: string | undefined | null, b: string) =>
  a != null && Date.parse(a) === Date.parse(b);

test.provider("create, update window in place, delete silence", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const { start, end, extendedEnd } = yield* silenceWindow;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const policy = yield* Cloudflare.Alerting.NotificationPolicy(
          "SilencedPolicy",
          {
            alertType: "universal_ssl_event_type",
            mechanisms: { email: [{ id: EMAIL }] },
          },
        );
        return yield* Cloudflare.Alerting.Silence("Maintenance", {
          policyId: policy.policyId,
          startTime: start,
          endTime: end,
        });
      }),
    );

    expect(initial.silenceId).toBeDefined();
    expect(initial.accountId).toEqual(accountId);
    expect(initial.policyId).toBeDefined();
    expect(sameInstant(initial.startTime, start)).toBe(true);
    expect(sameInstant(initial.endTime, end)).toBe(true);

    // Verify out-of-band via the API.
    const actual = yield* alerting.getSilence({
      accountId,
      silenceId: initial.silenceId,
    });
    expect(actual.policyId).toEqual(initial.policyId);
    expect(sameInstant(actual.startTime, start)).toBe(true);
    expect(sameInstant(actual.endTime, end)).toBe(true);

    // Extend the window in place — same silence id.
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const policy = yield* Cloudflare.Alerting.NotificationPolicy(
          "SilencedPolicy",
          {
            alertType: "universal_ssl_event_type",
            mechanisms: { email: [{ id: EMAIL }] },
          },
        );
        return yield* Cloudflare.Alerting.Silence("Maintenance", {
          policyId: policy.policyId,
          startTime: start,
          endTime: extendedEnd,
        });
      }),
    );

    expect(updated.silenceId).toEqual(initial.silenceId);
    expect(sameInstant(updated.endTime, extendedEnd)).toBe(true);

    const afterUpdate = yield* alerting.getSilence({
      accountId,
      silenceId: initial.silenceId,
    });
    expect(sameInstant(afterUpdate.endTime, extendedEnd)).toBe(true);

    yield* stack.destroy();

    yield* waitForSilenceDeleted(accountId, initial.silenceId);
  }).pipe(logLevel),
);

test.provider("replaces silence when the policy changes", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const { start, end } = yield* silenceWindow;

    yield* stack.destroy();

    const deploySilence = (policyResourceId: "PolicyA" | "PolicyB") =>
      stack.deploy(
        Effect.gen(function* () {
          const policyA = yield* Cloudflare.Alerting.NotificationPolicy(
            "PolicyA",
            {
              alertType: "universal_ssl_event_type",
              mechanisms: { email: [{ id: EMAIL }] },
            },
          );
          const policyB = yield* Cloudflare.Alerting.NotificationPolicy(
            "PolicyB",
            {
              alertType: "universal_ssl_event_type",
              mechanisms: { email: [{ id: EMAIL }] },
            },
          );
          const target = policyResourceId === "PolicyA" ? policyA : policyB;
          const silence = yield* Cloudflare.Alerting.Silence("ReplaceMe", {
            policyId: target.policyId,
            startTime: start,
            endTime: end,
          });
          return { policyA, policyB, silence };
        }),
      );

    const initial = yield* deploySilence("PolicyA");
    expect(initial.silence.policyId).toEqual(initial.policyA.policyId);

    // Pointing the silence at a different policy is a replacement — the
    // silence update API cannot move a silence between policies.
    const replaced = yield* deploySilence("PolicyB");
    expect(replaced.silence.policyId).toEqual(replaced.policyB.policyId);
    expect(replaced.silence.silenceId).not.toEqual(initial.silence.silenceId);

    // The replaced (old) silence must be gone.
    yield* waitForSilenceDeleted(accountId, initial.silence.silenceId);

    const actual = yield* alerting.getSilence({
      accountId,
      silenceId: replaced.silence.silenceId,
    });
    expect(actual.policyId).toEqual(replaced.policyB.policyId);

    yield* stack.destroy();

    yield* waitForSilenceDeleted(accountId, replaced.silence.silenceId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed silence", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const { start, end } = yield* silenceWindow;

    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const policy = yield* Cloudflare.Alerting.NotificationPolicy(
          "ListedPolicy",
          {
            alertType: "universal_ssl_event_type",
            mechanisms: { email: [{ id: EMAIL }] },
          },
        );
        return yield* Cloudflare.Alerting.Silence("ListedSilence", {
          policyId: policy.policyId,
          startTime: start,
          endTime: end,
        });
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Alerting.Silence);
    const all = yield* provider.list();

    expect(all.some((s) => s.silenceId === deployed.silenceId)).toBe(true);

    yield* stack.destroy();

    yield* waitForSilenceDeleted(accountId, deployed.silenceId);
  }).pipe(logLevel),
);

const waitForSilenceDeleted = (accountId: string, silenceId: string) =>
  alerting.getSilence({ accountId, silenceId }).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "SilenceNotDeleted" } as const)),
    Effect.catchTag("SilenceNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "SilenceNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );
