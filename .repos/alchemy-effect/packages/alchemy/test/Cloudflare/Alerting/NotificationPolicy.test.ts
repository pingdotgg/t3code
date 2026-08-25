import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as alerting from "@distilled.cloud/cloudflare/alerting";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const EMAIL = "test@alchemy.run";

test.provider("create, update, delete notification policy", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const policy = yield* stack.deploy(
      Cloudflare.Alerting.NotificationPolicy("SslPolicy", {
        alertType: "universal_ssl_event_type",
        mechanisms: { email: [{ id: EMAIL }] },
      }),
    );

    expect(policy.policyId).toBeDefined();
    expect(policy.accountId).toEqual(accountId);
    expect(policy.alertType).toEqual("universal_ssl_event_type");
    expect(policy.enabled).toBe(true);

    // Verify out-of-band via the API.
    const actual = yield* alerting.getPolicy({
      accountId,
      policyId: policy.policyId,
    });
    expect(actual.name).toEqual(policy.name);
    expect(actual.alertType).toEqual("universal_ssl_event_type");
    expect(actual.mechanisms?.email?.[0]?.id).toEqual(EMAIL);

    // Update mutable props in place — same id.
    const updated = yield* stack.deploy(
      Cloudflare.Alerting.NotificationPolicy("SslPolicy", {
        alertType: "universal_ssl_event_type",
        enabled: false,
        description: "paused during migration",
        mechanisms: { email: [{ id: EMAIL }] },
      }),
    );
    expect(updated.policyId).toEqual(policy.policyId);
    expect(updated.enabled).toBe(false);

    const afterUpdate = yield* alerting.getPolicy({
      accountId,
      policyId: policy.policyId,
    });
    expect(afterUpdate.enabled).toBe(false);
    expect(afterUpdate.description).toEqual("paused during migration");

    yield* stack.destroy();

    yield* waitForPolicyDeleted(accountId, policy.policyId);
  }).pipe(logLevel),
);

test.provider("replaces policy when alertType changes", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const policy = yield* stack.deploy(
      Cloudflare.Alerting.NotificationPolicy("ReplacePolicy", {
        alertType: "universal_ssl_event_type",
        mechanisms: { email: [{ id: EMAIL }] },
      }),
    );
    expect(policy.alertType).toEqual("universal_ssl_event_type");

    const replaced = yield* stack.deploy(
      Cloudflare.Alerting.NotificationPolicy("ReplacePolicy", {
        alertType: "incident_alert",
        mechanisms: { email: [{ id: EMAIL }] },
      }),
    );
    expect(replaced.alertType).toEqual("incident_alert");
    expect(replaced.policyId).not.toEqual(policy.policyId);

    // The replaced (old) policy must be gone.
    yield* waitForPolicyDeleted(accountId, policy.policyId);

    const actual = yield* alerting.getPolicy({
      accountId,
      policyId: replaced.policyId,
    });
    expect(actual.alertType).toEqual("incident_alert");

    yield* stack.destroy();

    yield* waitForPolicyDeleted(accountId, replaced.policyId);
  }).pipe(logLevel),
);

// Canonical `list()` test (account-scoped collection): deploy a real policy,
// then assert it appears in the exhaustively-paginated account-wide result.
test.provider("list enumerates the deployed notification policy", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Alerting.NotificationPolicy("ListPolicy", {
        alertType: "universal_ssl_event_type",
        mechanisms: { email: [{ id: EMAIL }] },
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Alerting.NotificationPolicy,
    );
    const all = yield* provider.list();

    expect(all.some((p) => p.policyId === deployed.policyId)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

const waitForPolicyDeleted = (accountId: string, policyId: string) =>
  alerting.getPolicy({ accountId, policyId }).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "PolicyNotDeleted" } as const)),
    Effect.catchTag("PolicyNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "PolicyNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );
