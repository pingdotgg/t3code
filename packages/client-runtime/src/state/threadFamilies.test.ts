import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetShellSnapshotError,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
import {
  createThreadFamilyAtoms,
  threadFamilyRead,
  threadFamilyRowsMissingFromShell,
} from "./threadFamilies.ts";

const row = (id: string, title = id) =>
  ({ id: ThreadId.make(id), title }) as unknown as OrchestrationV2ThreadShell;

describe("threadFamilyRowsMissingFromShell", () => {
  it("adds only the rows the shell left out, once, with shell rows winning", () => {
    const missing = threadFamilyRowsMissingFromShell({
      shellThreads: [row("parent"), row("live", "live from shell")],
      families: [
        { snapshotSequence: 4, threads: [row("live", "stale family copy"), row("idle")] },
        { snapshotSequence: 4, threads: [row("idle"), row("other")] },
      ],
      removedAt: new Map(),
    });
    expect(missing.map((thread) => thread.id)).toEqual(["idle", "other"]);
  });

  it("drops a family copy read before the shell removed that thread", () => {
    const missing = threadFamilyRowsMissingFromShell({
      shellThreads: [],
      families: [
        {
          snapshotSequence: 5,
          threads: [row("archived-after-read"), row("removed-before-read")],
        },
      ],
      removedAt: new Map([
        [ThreadId.make("archived-after-read"), 7],
        [ThreadId.make("removed-before-read"), 3],
      ]),
    });
    expect(missing.map((thread) => thread.id)).toEqual(["removed-before-read"]);
  });
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-family"),
  label: "Family environment",
  httpBaseUrl: "https://family.example.test",
  wsBaseUrl: "wss://family.example.test",
});

describe("createThreadFamilyAtoms", () => {
  it("merges mounted rows behind shell rows until released", () => {
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        {} as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"],
      ),
    );
    const shellState = Atom.make<AsyncResult.AsyncResult<EnvironmentShellState>>(
      AsyncResult.success<EnvironmentShellState>({
        ...EMPTY_SHELL_STATE,
        status: "live",
        generation: 1,
        snapshot: Option.some({
          schemaVersion: 1,
          snapshotSequence: 9,
          projects: [],
          threads: [row("kept")],
          archivedThreads: [],
          olderSettled: { before: "2026-10-01T00:00:00.000Z", asOfSequence: 4, counts: [] },
        } as OrchestrationV2ShellSnapshot),
        removedAt: new Map([[ThreadId.make("removed"), 9]]),
      }),
    );
    const families = createThreadFamilyAtoms(runtime, () => shellState);
    const registry = AtomRegistry.make();
    const merged = () => registry.get(families.snapshotAtom(TARGET.environmentId))?.threads;
    registry.mount(families.snapshotAtom(TARGET.environmentId));
    // A settled shelf page read at sequence 5: the shell's copy wins, a later removal drops a row.
    const page = Atom.make<ReadonlyArray<OrchestrationV2ThreadFamily>>([
      { snapshotSequence: 5, threads: [row("kept", "page copy"), row("old"), row("removed")] },
      // Read before the latest authoritative snapshot (sequence 4), whose removals it cleared.
      { snapshotSequence: 3, threads: [row("stale-search-row")] },
    ]);
    const release = families.mountRows(registry, TARGET.environmentId, "older-settled:page", page);
    expect(merged()?.map(({ id, title }) => [id, title])).toEqual([
      ["kept", "kept"],
      ["old", "old"],
    ]);
    release();
    expect(merged()?.map(({ id }) => id)).toEqual(["kept"]);
    registry.dispose();
  });

  it.effect("reads a family per shell generation and retries a failed read", () =>
    Effect.gen(function* () {
      const replies =
        yield* Queue.unbounded<
          Effect.Effect<OrchestrationV2ThreadFamily, OrchestrationV2GetShellSnapshotError>
        >();
      const requests: ThreadId[] = [];
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: ({ threadId }: { threadId: ThreadId }) =>
          Effect.sync(() => requests.push(threadId)).pipe(
            Effect.andThen(Effect.flatten(Queue.take(replies))),
          ),
      } as unknown as WsRpcProtocolClient;
      const session = {
        client,
        initialConfig: Effect.succeed({ shellThreadFamilies: true } as never),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      } as unknown as RpcSession.RpcSession;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
        setDiscoveredRoutes: () => Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
        _environmentId,
        effect,
      ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        _environmentId,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runtime = Atom.runtime(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            run,
            followStream,
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
      );
      const parent = row("parent");
      const child = row("idle-child");
      const shellSnapshot = {
        schemaVersion: 1,
        snapshotSequence: 3,
        projects: [],
        threads: [parent],
        archivedThreads: [],
      } as OrchestrationV2ShellSnapshot;
      const shellAt = (generation: number): EnvironmentShellState => ({
        ...EMPTY_SHELL_STATE,
        status: "live",
        snapshot: Option.some(shellSnapshot),
        generation,
      });
      const shellState = Atom.make<AsyncResult.AsyncResult<EnvironmentShellState>>(
        AsyncResult.success(shellAt(0)),
      );
      const families = createThreadFamilyAtoms(runtime, () => shellState);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const family = families.familyAtom(TARGET.environmentId, parent.id);
      const mergedIds = () =>
        registry.get(families.snapshotAtom(TARGET.environmentId))?.threads.map(({ id }) => id);
      // Waits for the read to finish either way; the assertions read its outcome.
      const settle = AtomRegistry.getResult(registry, family, { suspendOnWaiting: true }).pipe(
        Effect.ignore,
        Effect.tap(() => Effect.yieldNow),
      );
      registry.mount(families.snapshotAtom(TARGET.environmentId));
      families.mount(registry, TARGET.environmentId, parent.id);

      // A cached shell from before this session's first snapshot reads nothing.
      expect(threadFamilyRead(registry.get(family))).toBe("pending");
      expect(yield* Queue.size(replies)).toBe(0);

      registry.set(shellState, AsyncResult.success(shellAt(1)));
      yield* Queue.offer(replies, Effect.succeed({ snapshotSequence: 3, threads: [child] }));
      yield* settle;
      expect(threadFamilyRead(registry.get(family))).toBe("settled");
      expect(mergedIds()).toEqual(["parent", "idle-child"]);

      // A new authoritative snapshot never reuses the old read, even while the next one waits
      // or fails.
      registry.set(shellState, AsyncResult.success(shellAt(2)));
      expect(threadFamilyRead(registry.get(family))).toBe("pending");
      expect(mergedIds()).toEqual(["parent"]);
      yield* Queue.offer(
        replies,
        Effect.fail(new OrchestrationV2GetShellSnapshotError({ message: "read failed" })),
      );
      yield* settle;
      expect(threadFamilyRead(registry.get(family))).toBe("failed");
      expect(mergedIds()).toEqual(["parent"]);

      families.refresh(registry, TARGET.environmentId, parent.id);
      expect(threadFamilyRead(registry.get(family))).toBe("pending");
      yield* Queue.offer(replies, Effect.succeed({ snapshotSequence: 5, threads: [child] }));
      yield* settle;
      expect(threadFamilyRead(registry.get(family))).toBe("settled");
      expect(mergedIds()).toEqual(["parent", "idle-child"]);

      const visible = row("visible-citation");
      const omitted = row("omitted-citation");
      registry.set(
        shellState,
        AsyncResult.success({
          ...shellAt(2),
          snapshot: Option.some({ ...shellSnapshot, threads: [parent, visible] }),
        }),
      );
      const releaseVisible = families.mount(registry, TARGET.environmentId, visible.id, {
        onlyWhenMissing: true,
      });
      const releaseOmitted = families.mount(registry, TARGET.environmentId, omitted.id, {
        onlyWhenMissing: true,
      });
      yield* Queue.offerAll(replies, [
        Effect.succeed({ snapshotSequence: 5, threads: [omitted] }),
        Effect.succeed({ snapshotSequence: 5, threads: [visible] }),
      ]);
      yield* AtomRegistry.getResult(
        registry,
        families.familyAtom(TARGET.environmentId, omitted.id),
        { suspendOnWaiting: true },
      );
      expect(requests).toEqual([parent.id, parent.id, parent.id, omitted.id]);
      expect(mergedIds()).toEqual(["parent", "visible-citation", "idle-child", "omitted-citation"]);

      registry.set(shellState, AsyncResult.success(shellAt(2)));
      yield* AtomRegistry.getResult(
        registry,
        families.familyAtom(TARGET.environmentId, visible.id),
        { suspendOnWaiting: true },
      );
      expect(requests).toEqual([parent.id, parent.id, parent.id, omitted.id, visible.id]);
      expect(mergedIds()).toEqual(["parent", "idle-child", "visible-citation", "omitted-citation"]);
      releaseVisible();
      releaseOmitted();
      expect(mergedIds()).toEqual(["parent", "idle-child"]);

      const unavailable = row("cached-failure");
      const unavailableFamily = families.familyAtom(TARGET.environmentId, unavailable.id);
      const releaseFailed = families.mount(registry, TARGET.environmentId, unavailable.id);
      yield* Queue.offer(
        replies,
        Effect.fail(new OrchestrationV2GetShellSnapshotError({ message: "read failed" })),
      );
      yield* AtomRegistry.getResult(registry, unavailableFamily, {
        suspendOnWaiting: true,
      }).pipe(Effect.ignore);
      expect(threadFamilyRead(registry.get(unavailableFamily))).toBe("failed");
      releaseFailed();
      registry.set(
        shellState,
        AsyncResult.success({
          ...shellAt(2),
          snapshot: Option.some({ ...shellSnapshot, threads: [parent, unavailable] }),
        }),
      );
      const releaseRetry = families.mount(registry, TARGET.environmentId, unavailable.id, {
        onlyWhenMissing: true,
      });
      expect(requests.filter((id) => id === unavailable.id)).toHaveLength(1);
      registry.set(shellState, AsyncResult.success(shellAt(2)));
      yield* settle;
      expect(threadFamilyRead(registry.get(unavailableFamily))).toBe("pending");
      yield* Queue.offer(replies, Effect.succeed({ snapshotSequence: 5, threads: [unavailable] }));
      yield* AtomRegistry.getResult(registry, unavailableFamily, { suspendOnWaiting: true });
      expect(requests.filter((id) => id === unavailable.id)).toHaveLength(2);
      expect(mergedIds()).toEqual(["parent", "idle-child", "cached-failure"]);
      releaseRetry();
      expect(mergedIds()).toEqual(["parent", "idle-child"]);
    }),
  );
});
