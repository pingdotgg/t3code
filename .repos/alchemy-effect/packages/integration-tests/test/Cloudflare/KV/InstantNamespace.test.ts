import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as KV from "@alchemy.run/cloudflare/KV";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { Action } from "alchemy/Action";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "create and delete namespace with default props",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const namespace = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.InstantNamespace("DefaultNamespace");
        }),
      );

      expect(namespace.title).toBeDefined();
      expect(namespace.namespaceId).toBeDefined();

      const actualNamespace = yield* kv.getNamespace({
        accountId,
        namespaceId: namespace.namespaceId,
      });
      expect(actualNamespace.id).toEqual(namespace.namespaceId);
      expect(actualNamespace.mode).toEqual("instant");

      yield* stack.destroy();

      yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
    }).pipe(logLevel),
  { retry: 0, timeout: 120_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "live"] },
);

test.provider(
  "create, update, delete namespace",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const namespace = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.InstantNamespace("TestNamespace");
        }),
      );

      const actualNamespace = yield* kv.getNamespace({
        accountId,
        namespaceId: namespace.namespaceId,
      });
      expect(actualNamespace.id).toEqual(namespace.namespaceId);
      expect(actualNamespace.mode).toEqual("instant");
      expect(actualNamespace.title).toEqual(namespace.title);

      const updatedNamespace = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.InstantNamespace("TestNamespace", {
            title: namespace.title + "-updated",
          });
        }),
      );

      const actualUpdatedNamespace = yield* kv.getNamespace({
        accountId,
        namespaceId: updatedNamespace.namespaceId,
      });
      expect(actualUpdatedNamespace.mode).toEqual("instant");
      expect(updatedNamespace.namespaceId).toEqual(namespace.namespaceId);
      expect(actualUpdatedNamespace.title).toEqual(namespace.title + "-updated");
      expect(actualUpdatedNamespace.id).toEqual(updatedNamespace.namespaceId);

      yield* stack.destroy();

      yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
    }).pipe(logLevel),
  { retry: 0, timeout: 120_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "live"] },
);

// Canonical `list()` test (account-scoped collection): deploy a real
// namespace, resolve the provider from context via `findProviderByType`,
// call `list()`, and assert the deployed namespace appears in the
// exhaustively-paginated result.
test.provider(
  "list separates classic and instant namespaces",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { instant, classic } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            instant: yield* KV.InstantNamespace("Instant"),
            classic: yield* KV.Namespace("Classic"),
          };
        }),
      );
      const instantProvider = yield* Provider.findProvider(KV.InstantNamespace);
      const classicProvider = yield* Provider.findProvider(KV.Namespace);
      const instantNamespaces = yield* instantProvider.list();
      const classicNamespaces = yield* classicProvider.list();
      expect(instantNamespaces.some((ns) => ns.namespaceId === instant.namespaceId)).toBe(true);
      expect(instantNamespaces.some((ns) => ns.namespaceId === classic.namespaceId)).toBe(false);
      expect(classicNamespaces.some((ns) => ns.namespaceId === classic.namespaceId)).toBe(true);
      expect(classicNamespaces.some((ns) => ns.namespaceId === instant.namespaceId)).toBe(false);
      yield* stack.destroy();
    }).pipe(logLevel),
  { retry: 0, timeout: 120_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "live"] },
);

// Engine-level adoption: KV namespaces have no ownership signal (Cloudflare
// doesn't expose tags on KV), so a name match in `read` is treated as silent
// adoption. The test wipes local state mid-run while leaving the namespace
// on Cloudflare — this simulates a fresh state store seeing an existing
// resource with the same physical name.
test.provider(
  "existing namespace (matching title) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: deploy normally so a real KV namespace exists on
      // Cloudflare. No explicit `title` — the engine generates a
      // random-suffixed physical name (collision-free across concurrent
      // runs); the deploy output hands back the real title, which pins the
      // namespace's identity for the adoption phase below.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.InstantNamespace("AdoptableNamespace");
        }),
      );
      const title = initial.title;
      const initialId = initial.namespaceId;
      expect(initialId).toBeDefined();

      // Phase 2: wipe local state — the namespace stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "AdoptableNamespace" });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which lists namespaces, matches by title, and
      // returns plain attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.InstantNamespace("AdoptableNamespace", { title });
        }),
      );

      // Same physical namespace — adoption, not re-creation.
      expect(adopted.namespaceId).toEqual(initialId);
      expect(adopted.title).toEqual(title);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: stack.stage,
          fqn: "AdoptableNamespace",
        });
      }).pipe(Effect.provide(stack.state));

      expect((persisted as any)?.attr).toMatchObject({ namespaceId: initialId, title });

      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(initialId, accountId);
    }).pipe(logLevel),
  { retry: 0, timeout: 120_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "live"] },
);

const waitForNamespaceToBeDeleted = Effect.fn(function* (namespaceId: string, accountId: string) {
  yield* kv.getNamespace({ accountId, namespaceId }).pipe(
    Effect.flatMap(() => Effect.fail(new NamespaceStillExists())),
    Effect.retry({
      while: (e): e is NamespaceStillExists => e instanceof NamespaceStillExists,
      schedule: Schedule.exponential(100),
      times: 8,
    }),
    Effect.catchTag("NamespaceNotFound", () => Effect.void),
  );
});

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists") {}

// One successful execution performs 1 put + 1 list + 1 delete ($0.30), plus reads/storage.
// Never reuse the 1,001-key local fixture here. Do not retry this whole test.
test.provider(
  "Instant client: put, get, list all keys, and delete from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const namespace = yield* Cloudflare.KV.InstantNamespace("SeedNamespace");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
              // Accessor — resolved at apply time against the tracker.
              const namespaceId = yield* namespace.namespaceId;

              return Effect.fn(function* () {
                yield* kv.put("greeting", "hello world");

                // Retry only propagation mismatches; surface API errors immediately.
                const value = yield* kv.get("greeting").pipe(
                  Effect.flatMap((v) =>
                    v === "hello world"
                      ? Effect.succeed(v)
                      : Effect.fail("not yet propagated" as const),
                  ),
                  Effect.retry({
                    schedule: Schedule.spaced("1 second"),
                    while: (error) => error === "not yet propagated",
                    times: 10,
                  }),
                );

                const listed = yield* kv.list();
                expect(listed.list_complete).toBe(true);
                const names = listed.keys.map((k) => k.name);

                // Instant allows only one write per namespace per second.
                yield* Effect.sleep("1 second");
                yield* kv.delete("greeting");

                const afterDelete = yield* kv.get("greeting").pipe(
                  Effect.flatMap((v) =>
                    v === null ? Effect.succeed(v) : Effect.fail("not yet deleted" as const),
                  ),
                  Effect.retry({
                    schedule: Schedule.spaced("1 second"),
                    while: (error) => error === "not yet deleted",
                    times: 10,
                  }),
                );

                return {
                  namespaceId: yield* namespaceId,
                  value,
                  names,
                  afterDelete,
                };
              });
            }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceLocal)),
          );

          return yield* Seed({});
        }),
      );

      expect(out.namespaceId).toBeTruthy();
      expect(out.value).toBe("hello world");
      expect(out.names).toContain("greeting");
      expect(out.afterDelete).toBeNull();

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:kv", "live"],
    retry: 0,
    timeout: 120_000,
  },
);

test.provider(
  "switching namespace modes replaces storage while reusing an explicit title",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const classic = yield* stack.deploy(KV.Namespace("Config"));
      const instant = yield* stack.deploy(KV.InstantNamespace("Config", { title: classic.title }));
      expect(instant.namespaceId).not.toBe(classic.namespaceId);
      expect(instant.title).toBe(classic.title);
      expect((yield* kv.getNamespace({ accountId, namespaceId: instant.namespaceId })).mode).toBe(
        "instant",
      );
      yield* waitForNamespaceToBeDeleted(classic.namespaceId, accountId);
      const restored = yield* stack.deploy(KV.Namespace("Config", { title: classic.title }));
      expect(restored.namespaceId).not.toBe(instant.namespaceId);
      expect(restored.title).toBe(classic.title);
      expect(
        (yield* kv.getNamespace({ accountId, namespaceId: restored.namespaceId })).mode,
      ).not.toBe("instant");
      yield* waitForNamespaceToBeDeleted(instant.namespaceId, accountId);
      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(restored.namespaceId, accountId);
    }).pipe(logLevel),
  { retry: 0, timeout: 120_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "live"] },
);
