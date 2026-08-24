import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as calls from "@distilled.cloud/cloudflare/calls";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getTurnKey = (accountId: string, keyId: string) =>
  calls.getTurn({ accountId, keyId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, keyId: string) =>
  getTurnKey(accountId, keyId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "TurnKeyNotDeleted" } as const)),
    // A missing TURN key surfaces as `TurnKeyNotFound` (Cloudflare error
    // code 20008) — that's the success condition here.
    Effect.catchTag("TurnKeyNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "TurnKeyNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create and delete a TURN key with default name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const turnKey = yield* stack.deploy(
      Cloudflare.Calls.TurnKey("DefaultTurnKey", {}),
    );

    expect(turnKey.keyId).toBeTruthy();
    expect(Redacted.value(turnKey.key)).toBeTruthy();
    expect(turnKey.accountId).toEqual(accountId);
    expect(turnKey.name).toBeTruthy();

    const live = yield* getTurnKey(accountId, turnKey.keyId);
    expect(live.uid).toEqual(turnKey.keyId);
    expect(live.name).toEqual(turnKey.name);

    yield* stack.destroy();

    yield* expectGone(accountId, turnKey.keyId);
  }).pipe(logLevel),
);

test.provider("update name in place (same keyId, key preserved)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Calls.TurnKey("UpdateTurnKey", {
        name: "alchemy-calls-turn-update",
      }),
    );

    expect(initial.name).toEqual("alchemy-calls-turn-update");
    const initialKey = Redacted.value(initial.key);
    expect(initialKey).toBeTruthy();

    const updated = yield* stack.deploy(
      Cloudflare.Calls.TurnKey("UpdateTurnKey", {
        name: "alchemy-calls-turn-update-v2",
      }),
    );

    // Same TURN key mutated in place — not a replacement — and the
    // create-only key is carried forward across the update.
    expect(updated.keyId).toEqual(initial.keyId);
    expect(updated.name).toEqual("alchemy-calls-turn-update-v2");
    expect(Redacted.value(updated.key)).toEqual(initialKey);

    const live = yield* getTurnKey(accountId, updated.keyId);
    expect(live.name).toEqual("alchemy-calls-turn-update-v2");

    // Redeploying identical props is a no-op (still the same key).
    const noop = yield* stack.deploy(
      Cloudflare.Calls.TurnKey("UpdateTurnKey", {
        name: "alchemy-calls-turn-update-v2",
      }),
    );
    expect(noop.keyId).toEqual(initial.keyId);
    expect(Redacted.value(noop.key)).toEqual(initialKey);

    yield* stack.destroy();

    yield* expectGone(accountId, initial.keyId);
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const turnKey = yield* stack.deploy(
      Cloudflare.Calls.TurnKey("HealTurnKey", {
        name: "alchemy-calls-turn-heal",
      }),
    );

    // Delete the TURN key out-of-band. A redeploy with identical props is
    // a planner no-op, so change a prop to force reconcile — it must
    // observe the key as missing and recreate it instead of failing on
    // the 20008.
    yield* calls.deleteTurn({ accountId, keyId: turnKey.keyId }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );

    const healed = yield* stack.deploy(
      Cloudflare.Calls.TurnKey("HealTurnKey", {
        name: "alchemy-calls-turn-heal-v2",
      }),
    );

    expect(healed.keyId).not.toEqual(turnKey.keyId);
    expect(Redacted.value(healed.key)).toBeTruthy();
    expect(Redacted.value(healed.key)).not.toEqual(Redacted.value(turnKey.key));
    const live = yield* getTurnKey(accountId, healed.keyId);
    expect(live.name).toEqual("alchemy-calls-turn-heal-v2");

    yield* stack.destroy();

    yield* expectGone(accountId, healed.keyId);
  }).pipe(logLevel),
);

// Canonical `list()` test (account collection): deploy a TURN key, then
// enumerate every TURN key in the account via the provider's `list()` and
// assert the deployed key is present in the exhaustively-paginated result.
test.provider("list enumerates the deployed TURN key", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Calls.TurnKey("ListTurnKey", {
        name: "alchemy-calls-turn-list",
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Calls.TurnKey);
    const all = yield* provider.list();

    expect(all.some((x) => x.keyId === deployed.keyId)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);
