import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
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
const getNamespace = (accountId: string, name: string) =>
  aisearch.readNamespace({ accountId, name }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A freshly created namespace can lag on the read path — ride out
// `NamespaceNotFound` (Cloudflare error code 7063) with a bounded retry
// when the namespace is expected to exist.
const waitForNamespace = (accountId: string, name: string) =>
  getNamespace(accountId, name).pipe(
    Effect.retry({
      while: (e) => e._tag === "NamespaceNotFound",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, name: string) =>
  getNamespace(accountId, name).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "NamespaceNotDeleted" } as const)),
    // A missing namespace surfaces as `NamespaceNotFound` (Cloudflare
    // error code 7063) — that's the success condition here.
    Effect.catchTag("NamespaceNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "NamespaceNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Namespace reads are served eventually-consistently — poll (bounded)
// until the live description converges to the expected value.
const expectDescription = (
  accountId: string,
  name: string,
  expected: string | undefined,
) =>
  getNamespace(accountId, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (ns) => (ns.description ?? undefined) === expected,
      times: 30,
    }),
    Effect.map((ns) => expect(ns.description ?? undefined).toEqual(expected)),
  );

const program = (props?: Cloudflare.AI.SearchNamespaceProps) =>
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.AI.SearchNamespace("Namespace", {
      ...props,
    });
    return { namespace };
  });

test.provider(
  "create, update description in place, and delete a namespace",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — engine-generated name, no description.
      const initial = yield* stack.deploy(program());

      expect(initial.namespace.name).toBeTruthy();
      expect(initial.namespace.accountId).toEqual(accountId);
      expect(initial.namespace.description).toBeUndefined();

      const live = yield* waitForNamespace(accountId, initial.namespace.name);
      expect(live.name).toEqual(initial.namespace.name);

      // Update the description in place — same namespace (same name and
      // creation timestamp).
      const updated = yield* stack.deploy(
        program({ description: "alchemy aisearch namespace test" }),
      );

      expect(updated.namespace.name).toEqual(initial.namespace.name);
      expect(updated.namespace.description).toEqual(
        "alchemy aisearch namespace test",
      );

      yield* expectDescription(
        accountId,
        updated.namespace.name,
        "alchemy aisearch namespace test",
      );

      // Redeploying identical props is a no-op (still the same namespace).
      const noop = yield* stack.deploy(
        program({ description: "alchemy aisearch namespace test" }),
      );
      expect(noop.namespace.name).toEqual(initial.namespace.name);

      // Clearing the description converges back to unset.
      const cleared = yield* stack.deploy(program());
      expect(cleared.namespace.name).toEqual(initial.namespace.name);
      expect(cleared.namespace.description).toBeUndefined();

      yield* expectDescription(accountId, cleared.namespace.name, undefined);

      yield* stack.destroy();

      yield* expectGone(accountId, initial.namespace.name);

      // Destroy again — delete must be idempotent (already gone).
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "changing the name triggers a replacement",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const user = (process.env.USER ?? "test").toLowerCase();
      const nameA = `${user}-alch-ais-ns-a`;
      const nameB = `${user}-alch-ais-ns-b`;

      yield* stack.destroy();

      const initial = yield* stack.deploy(program({ name: nameA }));
      expect(initial.namespace.name).toEqual(nameA);

      const replaced = yield* stack.deploy(program({ name: nameB }));

      // The name is the namespace's identity — a new physical namespace
      // exists and the old one was deleted as part of the replacement.
      expect(replaced.namespace.name).toEqual(nameB);

      const live = yield* waitForNamespace(accountId, nameB);
      expect(live.name).toEqual(nameB);

      yield* expectGone(accountId, nameA);

      yield* stack.destroy();

      yield* expectGone(accountId, nameB);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// Canonical `list()` test (account-scoped collection): deploy a real
// namespace, resolve the provider from context via the typed
// `findProvider`, call `list()`, and assert the deployed namespace
// appears in the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(program());

      const provider = yield* Provider.findProvider(
        Cloudflare.AI.SearchNamespace,
      );
      const all = yield* provider.list();

      expect(all.some((ns) => ns.name === deployed.namespace.name)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "adopts the reserved default namespace without deleting it on teardown",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The account-provided `default` namespace always exists; adopting it
      // is bindable but must never be created or torn down.
      const adopted = yield* stack.deploy(program({ name: "default" }));
      expect(adopted.namespace.name).toEqual("default");

      const live = yield* getNamespace(accountId, "default");
      expect(live.name).toEqual("default");

      yield* stack.destroy();

      // Destroy is a no-op for the default namespace — it must still exist.
      const stillThere = yield* getNamespace(accountId, "default");
      expect(stillThere.name).toEqual("default");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "recreates after out-of-band delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(program());

      // Delete the namespace out-of-band. A redeploy with identical props
      // is a planner no-op, so change a mutable prop to force reconcile —
      // it must observe the namespace as missing and recreate it instead
      // of failing on a 404.
      yield* aisearch
        .deleteNamespace({ accountId, name: initial.namespace.name })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );
      yield* expectGone(accountId, initial.namespace.name);

      const healed = yield* stack.deploy(
        program({ description: "healed after out-of-band delete" }),
      );

      expect(healed.namespace.name).toEqual(initial.namespace.name);
      yield* expectDescription(
        accountId,
        healed.namespace.name,
        "healed after out-of-band delete",
      );

      yield* stack.destroy();

      yield* expectGone(accountId, healed.namespace.name);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
