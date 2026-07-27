import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as KV from "@/Cloudflare/KV/index";
import * as Provider from "@/Provider";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete namespace with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const namespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.Namespace("DefaultNamespace");
      }),
    );

    expect(namespace.title).toBeDefined();
    expect(namespace.namespaceId).toBeDefined();

    const actualNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: namespace.namespaceId,
    });
    expect(actualNamespace.id).toEqual(namespace.namespaceId);

    yield* stack.destroy();

    yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete namespace", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const namespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.Namespace("TestNamespace");
      }),
    );

    const actualNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: namespace.namespaceId,
    });
    expect(actualNamespace.id).toEqual(namespace.namespaceId);
    expect(actualNamespace.title).toEqual(namespace.title);

    const updatedNamespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.Namespace("TestNamespace", {
          title: namespace.title + "-updated",
        });
      }),
    );

    const actualUpdatedNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: updatedNamespace.namespaceId,
    });
    expect(actualUpdatedNamespace.title).toEqual(namespace.title + "-updated");
    expect(actualUpdatedNamespace.id).toEqual(updatedNamespace.namespaceId);

    yield* stack.destroy();

    yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
  }).pipe(logLevel),
);

// Canonical `list()` test (account-scoped collection): deploy a real
// namespace, resolve the provider from context via `findProviderByType`,
// call `list()`, and assert the deployed namespace appears in the
// exhaustively-paginated result.
test.provider("list enumerates the deployed namespace", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const namespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.Namespace("ListNamespace");
      }),
    );

    const provider = yield* Provider.findProvider(KV.Namespace);
    const all = yield* provider.list();

    expect(all.some((ns) => ns.namespaceId === namespace.namespaceId)).toBe(
      true,
    );

    yield* stack.destroy();
  }).pipe(logLevel),
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
          return yield* KV.Namespace("AdoptableNamespace");
        }),
      );
      const title = initial.title;
      const initialId = initial.namespaceId;
      expect(initialId).toBeDefined();

      // Phase 2: wipe local state — the namespace stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableNamespace",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which lists namespaces, matches by title, and
      // returns plain attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.Namespace("AdoptableNamespace", { title });
        }),
      );

      // Same physical namespace — adoption, not re-creation.
      expect(adopted.namespaceId).toEqual(initialId);
      expect(adopted.title).toEqual(title);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableNamespace",
        });
      }).pipe(Effect.provide(stack.state));

      expect((persisted as any)?.attr).toMatchObject({
        namespaceId: initialId,
        title,
      });

      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(initialId, accountId);
    }).pipe(logLevel),
);

const waitForNamespaceToBeDeleted = Effect.fn(function* (
  namespaceId: string,
  accountId: string,
) {
  yield* kv
    .getNamespace({
      accountId,
      namespaceId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new NamespaceStillExists())),
      Effect.retry({
        while: (e): e is NamespaceStillExists =>
          e instanceof NamespaceStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NamespaceNotFound", () => Effect.void),
    );
});

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists") {}
