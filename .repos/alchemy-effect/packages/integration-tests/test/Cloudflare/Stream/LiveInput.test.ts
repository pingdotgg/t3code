import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as stream from "@distilled.cloud/cloudflare/stream";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getLiveInput = (accountId: string, liveInputId: string) =>
  stream.getLiveInput({ accountId, liveInputIdentifier: liveInputId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, liveInputId: string) =>
  getLiveInput(accountId, liveInputId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "LiveInputNotDeleted" } as const)),
    // A missing live input surfaces as `LiveInputNotFound` (Cloudflare
    // error code 10003) — that's the success condition here.
    Effect.catchTag("LiveInputNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "LiveInputNotDeleted",
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(10)]),
    }),
  );

test.provider(
  "create, update in place, and delete a live input",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const input = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("BroadcastInput", {
          meta: { name: "alchemy-stream-live-input" },
          recording: { mode: "automatic", timeoutSeconds: 10 },
        }),
      );

      expect(input.liveInputId).toBeTruthy();
      expect(input.accountId).toEqual(accountId);
      expect(input.enabled).toBe(true);
      expect(input.meta).toMatchObject({ name: "alchemy-stream-live-input" });

      const live = yield* getLiveInput(accountId, input.liveInputId);
      expect(live.uid).toEqual(input.liveInputId);
      expect(live.enabled).toBe(true);

      // Update mutable props in place — same uid, no replacement.
      const updated = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("BroadcastInput", {
          enabled: false,
          meta: { name: "alchemy-stream-live-input-v2" },
          recording: { mode: "automatic", timeoutSeconds: 10 },
        }),
      );

      expect(updated.liveInputId).toEqual(input.liveInputId);
      expect(updated.enabled).toBe(false);
      expect(updated.meta).toMatchObject({
        name: "alchemy-stream-live-input-v2",
      });

      const observed = yield* getLiveInput(accountId, updated.liveInputId);
      expect(observed.enabled).toBe(false);

      // Redeploying identical props is a no-op (still the same input).
      const noop = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("BroadcastInput", {
          enabled: false,
          meta: { name: "alchemy-stream-live-input-v2" },
          recording: { mode: "automatic", timeoutSeconds: 10 },
        }),
      );
      expect(noop.liveInputId).toEqual(input.liveInputId);

      yield* stack.destroy();

      yield* expectGone(accountId, input.liveInputId);
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:stream", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "recreates after out-of-band delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const input = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("HealInput", {
          meta: { name: "alchemy-stream-heal-input" },
        }),
      );

      // Delete the live input out-of-band. A redeploy with identical props
      // is a planner no-op, so change a prop to force reconcile — it must
      // observe the input as missing and recreate it instead of failing.
      yield* stream.deleteLiveInput({ accountId, liveInputIdentifier: input.liveInputId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

      const healed = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("HealInput", {
          enabled: false,
          meta: { name: "alchemy-stream-heal-input" },
        }),
      );

      expect(healed.liveInputId).not.toEqual(input.liveInputId);
      expect(healed.enabled).toBe(false);

      yield* stack.destroy();

      yield* expectGone(accountId, healed.liveInputId);
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:stream", "live"],
    timeout: 120_000,
  },
);

// Canonical `list()` test (account collection): deploy a live input, then
// resolve the typed provider and assert the deployed uid appears in the
// exhaustively-enumerated result.
test.provider(
  "list enumerates the deployed live input",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const input = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("ListInput", {
          meta: { name: "alchemy-stream-list-input" },
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Stream.LiveInput);
      const all = yield* provider.list();

      expect(all.some((x) => x.liveInputId === input.liveInputId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:stream", "live"],
    timeout: 120_000,
  },
);
