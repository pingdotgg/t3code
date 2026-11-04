import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStorageError,
} from "@t3tools/client-runtime/platform";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { vi } from "vite-plus/test";

import {
  browserThreadTriageOutboxStorage,
  browserThreadTriageOutboxStore,
} from "./threadTriageOutboxStore";

const settle = (threadId: string) => ({
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make(threadId),
  commandId: CommandId.make(`settle-${threadId}`),
  action: { type: "settle" as const },
  queuedAt: DateTime.makeUnsafe("2026-09-12T10:00:00.000Z"),
  snapshotSequence: 1,
});

const replaceStored = (raw: string) => browserThreadTriageOutboxStorage.modify(() => raw);

describe("browser thread triage storage", () => {
  it.effect("keeps every tab's change when tabs save at the same time", () =>
    Effect.gen(function* () {
      yield* replaceStored(JSON.stringify({ entries: [], operableEnvironmentIds: [] }));
      const tab = () => makeThreadTriageOutboxStore(browserThreadTriageOutboxStorage);

      yield* Effect.all([tab().put(settle("first")), tab().put(settle("second"))], {
        concurrency: "unbounded",
      });

      const { entries } = yield* tab().load;
      expect(entries.map((entry) => entry.threadId).toSorted()).toEqual(["first", "second"]);
    }),
  );

  it.effect("discards an unreadable document on the caller's logger, then saves", () =>
    Effect.gen(function* () {
      yield* replaceStored("{invalid");
      const warnings: unknown[] = [];

      yield* browserThreadTriageOutboxStore
        .put(settle("thread"))
        .pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.make(({ message }) => warnings.push(message))]),
          ),
        );

      expect(warnings).toHaveLength(1);
      expect((yield* browserThreadTriageOutboxStore.load).entries).toEqual([settle("thread")]);
    }),
  );

  it.effect("clears retained environment state even when storage is unavailable", () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubGlobal("indexedDB", undefined)),
        () => Effect.sync(() => vi.unstubAllGlobals()),
      );
      const environmentId = EnvironmentId.make("removed");
      const retained = new Set([environmentId]);
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          browserThreadTriageOutboxStore.subscribeCleared((removed) => retained.delete(removed)),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );

      const result = yield* Effect.exit(
        browserThreadTriageOutboxStore.clearEnvironment(environmentId),
      );

      expect(result._tag === "Failure" && Cause.squash(result.cause)).toBeInstanceOf(
        ThreadTriageOutboxStorageError,
      );
      expect(retained.size).toBe(0);
    }),
  );
});
