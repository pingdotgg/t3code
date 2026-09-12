// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Index from "./WorkspaceSearchIndex.ts";
import { WorkspaceSearchWorkerPath } from "./WorkspaceSearchProcess.ts";
import { WorkspaceSearchHost } from "./WorkspaceSearchHost.ts";

const mockWorker = new URL("../../scripts/workspace-search-mock.ts", import.meta.url);
const withWorker = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(WorkspaceSearchHost.layer),
    Effect.provideService(WorkspaceSearchWorkerPath, mockWorker),
  );

const receipts = Effect.fn(function* () {
  const blocked = yield* Deferred.make<void>();
  const exited = yield* Deferred.make<void>();
  const server = NodeNet.createServer((socket) => {
    socket.once("data", () => Deferred.doneUnsafe(blocked, Effect.void));
    socket.once("close", () => Deferred.doneUnsafe(exited, Effect.void));
  });
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const address = server.address();
  if (!address || typeof address === "string") return yield* Effect.die("Missing receipt port");
  return {
    blocked,
    exited,
    environment: { ...process.env, T3_SEARCH_TEST_RECEIPT_PORT: String(address.port) },
  };
});

it.effect(
  "keeps HTTP responsive during a blocked search and rebuilds shared indexes after timeout",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const control = yield* receipts();
        const server = NodeHttp.createServer((_request, response) => response.end("healthy"));
        yield* Effect.acquireRelease(
          Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          ),
          () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const address = server.address();
        if (!address || typeof address === "string") return yield* Effect.die("Missing HTTP port");
        yield* Effect.gen(function* () {
          const index = yield* Index.make("workspace");
          const initial = yield* index.list();
          const other = yield* Index.make("another-workspace");
          expect((yield* other.list()).entries).toEqual(initial.entries);
          const blocked = yield* index.search("block", 1).pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(control.blocked);

          const health = yield* HttpClient.get(`http://127.0.0.1:${address.port}`).pipe(
            Effect.flatMap((response) => response.text),
            Effect.provide(NodeHttpClient.layerNodeHttp),
          );
          expect(health).toBe("healthy");
          yield* TestClock.adjust("1 second");
          const queued = yield* other.list().pipe(Effect.forkChild);

          yield* TestClock.adjust("19 seconds");
          const result = yield* Fiber.join(blocked);
          expect(Exit.isFailure(result)).toBe(true);
          yield* Deferred.await(control.exited);
          const recovered = yield* Fiber.join(queued);
          expect(recovered.entries).not.toEqual(initial.entries);
          expect((yield* index.list()).entries).toEqual(recovered.entries);
        }).pipe(Effect.provideService(HostProcessEnvironment, control.environment));
      }).pipe(withWorker),
    ),
);

it.effect("cancels a blocked request before allowing the queued request to rebuild", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* receipts();
      yield* Effect.gen(function* () {
        const index = yield* Index.make("workspace");
        const original = yield* index.list();
        const blocked = yield* index.search("block", 1).pipe(Effect.forkChild);
        yield* Deferred.await(control.blocked);
        const queued = yield* index.list().pipe(Effect.forkChild);
        yield* Fiber.interrupt(blocked);
        yield* Deferred.await(control.exited);
        expect((yield* Fiber.join(queued)).entries).not.toEqual(original.entries);
      }).pipe(Effect.provideService(HostProcessEnvironment, control.environment));
    }).pipe(withWorker),
  ),
);

it.effect("bounds initialization even when the native scan never returns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* receipts();
      const startup = yield* Index.make("block-initialize").pipe(
        Effect.provideService(HostProcessEnvironment, control.environment),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(control.blocked);
      yield* TestClock.adjust("20 seconds");
      expect(Exit.isFailure(yield* Fiber.join(startup))).toBe(true);
      yield* Deferred.await(control.exited);
    }).pipe(withWorker),
  ),
);

it.effect("kills a blocked native call when the owning index scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* receipts();
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const index = yield* Index.make("workspace").pipe(
        Scope.provide(scope),
        Effect.provideService(HostProcessEnvironment, control.environment),
      );
      const blocked = yield* index.search("block", 1).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(control.blocked);
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(closing);
      yield* Deferred.await(control.exited);
      expect(Exit.isFailure(yield* Fiber.join(blocked))).toBe(true);
    }).pipe(withWorker),
  ),
);

it.effect("preserves native timeout and refresh errors across IPC and recovers after a crash", () =>
  Effect.scoped(
    Effect.gen(function* () {
      expect(yield* Effect.flip(Index.make("scan-timeout"))).toBeInstanceOf(
        Index.WorkspaceSearchIndexScanTimedOut,
      );
      const index = yield* Index.make("workspace");
      const original = yield* index.list();
      expect(yield* Effect.flip(index.search("crash", 1))).toBeInstanceOf(
        Index.WorkspaceSearchIndexSearchFailed,
      );
      expect((yield* index.list()).entries).not.toEqual(original.entries);
      expect(yield* Effect.flip(index.refresh())).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        reason: "scan failed",
      });
      expect((yield* index.list()).entries).toHaveLength(1);
    }).pipe(withWorker),
  ),
);

it.effect("bounds native disposal and lazily rebuilds the surviving workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* receipts();
      yield* Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const retiring = yield* Index.make("block-dispose").pipe(Scope.provide(scope));
        const surviving = yield* Index.make("surviving");
        const before = yield* surviving.list();
        expect((yield* retiring.list()).entries).toEqual(before.entries);
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* Deferred.await(control.blocked);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(closing);
        yield* Deferred.await(control.exited);
        expect((yield* surviving.list()).entries).not.toEqual(before.entries);
        expect(yield* Effect.flip(retiring.list())).toBeInstanceOf(
          Index.WorkspaceSearchIndexSearchFailed,
        );
      }).pipe(Effect.provideService(HostProcessEnvironment, control.environment));
    }).pipe(withWorker),
  ),
);

it.effect("releases one index without restarting the process used by another index", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const retiring = yield* Index.make("retiring").pipe(Scope.provide(scope));
      const surviving = yield* Index.make("surviving");
      const before = yield* surviving.list();
      expect((yield* retiring.list()).entries).toEqual(before.entries);
      yield* Scope.close(scope, Exit.void);
      expect((yield* surviving.list()).entries).toEqual(before.entries);
      expect(yield* Effect.flip(retiring.list())).toBeInstanceOf(
        Index.WorkspaceSearchIndexSearchFailed,
      );
      expect((yield* surviving.list()).entries).toEqual(before.entries);
    }).pipe(withWorker),
  ),
);

it.effect("cancels a queued request without terminating the active search process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* receipts();
      yield* Effect.gen(function* () {
        const index = yield* Index.make("workspace");
        const other = yield* Index.make("other");
        const blocked = yield* index.search("block", 1).pipe(Effect.forkChild);
        yield* Deferred.await(control.blocked);
        const queued = yield* other.list().pipe(Effect.forkChild);
        yield* Fiber.interrupt(queued);
        expect(yield* Deferred.isDone(control.exited)).toBe(false);
        yield* Fiber.interrupt(blocked);
        yield* Deferred.await(control.exited);
        expect((yield* other.list()).entries).toHaveLength(1);
      }).pipe(Effect.provideService(HostProcessEnvironment, control.environment));
    }).pipe(withWorker),
  ),
);
