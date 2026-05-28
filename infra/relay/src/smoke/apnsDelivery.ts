import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/unstable/http";

import * as Apns from "../apns.ts";
import type { ApnsCredentials } from "../settings.ts";

type SmokeEvent = "start" | "update" | "end";
type SmokeKind = "live_activity" | "push_notification";

class SmokeConfigError extends Data.TaggedError("SmokeConfigError")<{
  readonly message: string;
}> {}

class SmokeDeliveryError extends Data.TaggedError("SmokeDeliveryError")<{
  readonly message: string;
}> {}

function readRequiredEnv(name: string): Effect.Effect<string, SmokeConfigError> {
  return Effect.sync(() => process.env[name]?.trim() ?? "").pipe(
    Effect.flatMap((value) =>
      value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(
            new SmokeConfigError({ message: `Missing required environment variable ${name}.` }),
          ),
    ),
  );
}

function readSmokeEvent(): Effect.Effect<SmokeEvent, SmokeConfigError> {
  return Effect.sync(() => process.env.APNS_EVENT?.trim() ?? "update").pipe(
    Effect.flatMap((value) =>
      value === "start" || value === "update" || value === "end"
        ? Effect.succeed(value)
        : Effect.fail(
            new SmokeConfigError({ message: "APNS_EVENT must be one of start, update, or end." }),
          ),
    ),
  );
}

function readSmokeKind(): Effect.Effect<SmokeKind, SmokeConfigError> {
  return Effect.sync(() => process.env.APNS_SMOKE_KIND?.trim() ?? "live_activity").pipe(
    Effect.flatMap((value) =>
      value === "live_activity" || value === "push_notification"
        ? Effect.succeed(value)
        : Effect.fail(
            new SmokeConfigError({
              message: "APNS_SMOKE_KIND must be either live_activity or push_notification.",
            }),
          ),
    ),
  );
}

function readApnsEnvironment(): Effect.Effect<ApnsCredentials["environment"], SmokeConfigError> {
  return Effect.sync(() => process.env.APNS_ENVIRONMENT?.trim() ?? "sandbox").pipe(
    Effect.flatMap((value) =>
      value === "sandbox" || value === "production"
        ? Effect.succeed(value)
        : Effect.fail(
            new SmokeConfigError({
              message: "APNS_ENVIRONMENT must be either sandbox or production.",
            }),
          ),
    ),
  );
}

function makeSmokeAggregate(nowIso: string): RelayAgentActivityAggregateState {
  return {
    title: process.env.APNS_SMOKE_TITLE?.trim() || "T3 Code",
    subtitle: process.env.APNS_SMOKE_SUBTITLE?.trim() || "APNs Live Activity smoke test",
    activeCount: 1,
    updatedAt: nowIso,
    activities: [
      {
        environmentId: "env_apns_smoke",
        threadId: "thread_apns_smoke",
        projectTitle: "APNs Smoke",
        threadTitle: "Live Activity delivery",
        modelTitle: "Smoke",
        phase: "running",
        status: "Working",
        updatedAt: nowIso,
        deepLink: "t3code://agent-activity-smoke",
      },
    ],
  } as unknown as RelayAgentActivityAggregateState;
}

const readCredentials = Effect.gen(function* () {
  const environment = yield* readApnsEnvironment();
  const [teamId, keyId, bundleId, privateKey] = yield* Effect.all([
    readRequiredEnv("APNS_TEAM_ID"),
    readRequiredEnv("APNS_KEY_ID"),
    readRequiredEnv("APNS_BUNDLE_ID"),
    readRequiredEnv("APNS_PRIVATE_KEY"),
  ]);
  return {
    environment,
    teamId: Redacted.make(teamId),
    keyId: Redacted.make(keyId),
    bundleId: Redacted.make(bundleId),
    privateKey: Redacted.make(privateKey),
  } satisfies ApnsCredentials;
});

export const apnsDeliverySmoke = Effect.gen(function* () {
  const [credentials, kind, event, now] = yield* Effect.all([
    readCredentials,
    readSmokeKind(),
    readSmokeEvent(),
    DateTime.now,
  ]);
  const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const nowIso = DateTime.formatIso(now);

  const result =
    kind === "push_notification"
      ? yield* Apns.sendPushNotificationRequest({
          credentials,
          request: Apns.makePushNotificationRequest({
            token: yield* readRequiredEnv("APNS_PUSH_TOKEN"),
            notification: {
              title: process.env.APNS_SMOKE_TITLE?.trim() || "T3 Code",
              body: process.env.APNS_SMOKE_SUBTITLE?.trim() || "APNs notification smoke test",
              environmentId: "env_apns_smoke",
              threadId: "thread_apns_smoke",
              deepLink: "/threads/env_apns_smoke/thread_apns_smoke",
            },
          }),
          issuedAtUnixSeconds: epochSeconds,
        })
      : yield* Effect.gen(function* () {
          const state = makeSmokeAggregate(nowIso);
          const request = Apns.makeLiveActivityRequest(
            event === "end"
              ? {
                  token: yield* readRequiredEnv("APNS_LIVE_ACTIVITY_TOKEN"),
                  event,
                  state: process.env.APNS_END_WITH_STATE === "1" ? state : null,
                  nowEpochSeconds: epochSeconds,
                  nowIso,
                }
              : {
                  token: yield* readRequiredEnv("APNS_LIVE_ACTIVITY_TOKEN"),
                  event,
                  state,
                  nowEpochSeconds: epochSeconds,
                  nowIso,
                },
          );
          return yield* Apns.sendLiveActivityRequest({
            credentials,
            request,
            issuedAtUnixSeconds: epochSeconds,
          });
        });

  yield* Console.log("APNs smoke result", {
    ok: result.ok,
    kind,
    event,
    environment: credentials.environment,
    status: result.status,
    reason: result.reason ?? null,
    apnsId: result.apnsId,
  });
  if (!result.ok) {
    return yield* new SmokeDeliveryError({
      message: result.reason ?? `APNs delivery failed with status ${result.status}.`,
    });
  }
  return result;
}).pipe(Effect.provide(FetchHttpClient.layer));

if (import.meta.main) {
  Effect.runPromise(
    apnsDeliverySmoke.pipe(
      Effect.catch((error) =>
        Console.error(error instanceof SmokeConfigError ? error.message : String(error)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    ),
  );
}
