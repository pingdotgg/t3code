import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { EnvironmentId } from "@t3tools/contracts";

import {
  type DrainDependencies,
  FleetDrainStepError,
  makeDrainExecutor,
} from "./OpenShellFleetDrain.ts";

const environmentId = EnvironmentId.make("environment:worker");

const deps = (input: {
  readonly threads: ReadonlyArray<string>;
  readonly projects?: ReadonlyArray<string>;
  readonly now?: number;
  readonly failThread?: string;
  readonly pushExitCode?: number;
  readonly liveThread?: string;
  readonly sequences?: Readonly<Record<string, number>>;
  readonly attachmentFiles?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly oversizeThreads?: ReadonlyArray<string>;
  readonly dropAttachmentManifest?: boolean;
  readonly seeded?: ReadonlyArray<{
    readonly drainId: string;
    readonly threadId: string;
    readonly snapshotSequence: number | null;
    readonly attachments?: boolean;
  }>;
}): DrainDependencies & {
  readonly written: Array<{ drainId: string; threadId: string; body: string }>;
  readonly fetched: Array<string>;
  readonly fetchedAttachments: Array<string>;
  readonly pushed: Array<string>;
} => {
  const manifest = [{ name: "a.bin", hash: "h0", size: 3 }];
  const envelope = (entry: {
    threadId: string;
    snapshotSequence: number | null;
    attachments?: boolean;
  }) =>
    JSON.stringify({
      threadId: entry.threadId,
      snapshotSequence: entry.snapshotSequence,
      body: `{"threadId":"${entry.threadId}","seeded":true}`,
      ...(entry.attachments === true ? { attachments: manifest } : {}),
    });
  const files = new Map<string, string>(
    (input.seeded ?? []).map((entry) => [`${entry.drainId}/${entry.threadId}`, envelope(entry)]),
  );
  const written: Array<{ drainId: string; threadId: string; body: string }> = [];
  const fetched: Array<string> = [];
  const fetchedAttachments: Array<string> = [];
  const pushed: Array<string> = [];
  return {
    written,
    fetched,
    fetchedAttachments,
    pushed,
    now: Effect.succeed(input.now ?? 0),
    source: {
      shell: () =>
        Effect.succeed({
          threads: input.threads.map((threadId) => ({
            threadId,
            live: input.liveThread === threadId,
          })),
          projects: (input.projects ?? []).map((workspaceRoot) => ({ workspaceRoot })),
        }),
      threadSequence: ({ threadId }) =>
        Effect.succeed({ snapshotSequence: input.sequences?.[threadId] ?? 1 }),
      threadHistory: ({ threadId }) => {
        fetched.push(threadId);
        return threadId === input.failThread
          ? Effect.fail(
              new FleetDrainStepError({ step: "history", message: "the worker went away" }),
            )
          : Effect.succeed({
              body: `{"threadId":"${threadId}","events":[1,2,3]}`,
              snapshotSequence: input.sequences?.[threadId] ?? 1,
            });
      },
      attachments: ({ threadId }) => {
        fetchedAttachments.push(threadId);
        if (input.oversizeThreads?.includes(threadId) === true) {
          return Effect.succeed({ files: [], oversizeSkipped: true });
        }
        return Effect.succeed({
          files: (input.attachmentFiles?.[threadId] ?? []).map((name) => ({
            name,
            bytes: Buffer.from(name, "utf8").toString("base64"),
          })),
          oversizeSkipped: false,
        });
      },
    },
    sink: {
      write: ({ drainId, threadId, body, snapshotSequence, attachments }) =>
        Effect.sync(() => {
          const stored = JSON.stringify({
            threadId,
            snapshotSequence,
            body,
            ...(input.dropAttachmentManifest === true
              ? {}
              : (attachments?.files ?? []).length > 0
                ? {
                    attachments: (attachments?.files ?? []).map((file) => ({
                      name: file.name,
                      hash: `h-${file.name}`,
                      size: file.bytes.length,
                    })),
                  }
                : {}),
            ...(attachments?.oversizeSkipped === true ? { attachmentsSkipped: true } : {}),
          });
          files.set(`${drainId}/${threadId}`, stored);
          written.push({ drainId, threadId, body });
          return { bytes: stored.length };
        }),
      read: ({ drainId, threadId }) =>
        Effect.map(
          Effect.sync(() => files.get(`${drainId}/${threadId}`)),
          (raw) => {
            if (raw === undefined) return null;
            const parsed = JSON.parse(raw) as {
              threadId: string;
              snapshotSequence?: number;
              body: string;
              attachments?: Array<{ name: string; hash: string; size: number }>;
              attachmentsSkipped?: boolean;
            };
            return {
              threadId: parsed.threadId,
              snapshotSequence:
                typeof parsed.snapshotSequence === "number" ? parsed.snapshotSequence : null,
              body: parsed.body,
              ...(parsed.attachments !== undefined && parsed.attachments.length > 0
                ? { attachments: parsed.attachments }
                : {}),
              ...(parsed.attachmentsSkipped === true ? { attachmentsSkipped: true } : {}),
            };
          },
        ),
    },
    git: {
      push: ({ workspaceRoot }) =>
        Effect.sync(() => {
          pushed.push(workspaceRoot);
          return { exitCode: input.pushExitCode ?? 0, stderr: "" };
        }),
    },
  };
};

const drain = (
  dependencies: DrainDependencies,
  overrides: Partial<{ drainId: string; deadlineAt: number; snapshotOnly: boolean }> = {},
) =>
  makeDrainExecutor(dependencies).drain({
    environmentId,
    sandboxName: "sandbox-1",
    drainId: overrides.drainId ?? "drain:environment:worker:1",
    snapshotOnly: overrides.snapshotOnly ?? false,
    deadlineAt: overrides.deadlineAt ?? Number.MAX_SAFE_INTEGER,
  });

describe("fleet drain", () => {
  it.effect("acks threads and checkout pushes only when each one landed", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a", "thread:b"], projects: ["/work/a"] });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("acked");
      expect(outcome.threads).toEqual({ total: 2, acked: 2, failed: 0 });
      expect(outcome.worktrees).toEqual({ total: 1, acked: 1, failed: 0 });
      expect(dependencies.pushed).toEqual(["/work/a"]);
    }),
  );

  it.effect("does not re-fetch a thread whose previous copy is still current", () =>
    Effect.gen(function* () {
      const first = deps({ threads: ["thread:a", "thread:b"], failThread: "thread:b" });
      yield* drain(first, { drainId: "drain:environment:worker:1" });
      const retry = deps({
        threads: ["thread:a", "thread:b"],
        seeded: first.written.map((entry) => ({
          drainId: "drain:environment:worker:1",
          threadId: entry.threadId,
          snapshotSequence: 1,
          attachments: true,
        })),
      });
      const outcome = yield* drain(retry, { drainId: "drain:environment:worker:2" });

      expect(outcome.state).toBe("acked");
      // thread:a is still current, so only the failed thread is fetched again.
      expect(retry.fetched).toEqual(["thread:b"]);
      expect(retry.written.map((entry) => entry.threadId)).toEqual(["thread:b"]);
    }),
  );

  it.effect("re-copies a thread whose worker state changed since the failed drain", () =>
    Effect.gen(function* () {
      const first = deps({ threads: ["thread:a", "thread:b"], failThread: "thread:b" });
      yield* drain(first, { drainId: "drain:environment:worker:1" });
      const retry = deps({
        threads: ["thread:a", "thread:b"],
        sequences: { "thread:a": 2 },
        seeded: first.written.map((entry) => ({
          drainId: "drain:environment:worker:1",
          threadId: entry.threadId,
          snapshotSequence: 1,
          attachments: true,
        })),
      });
      const outcome = yield* drain(retry, { drainId: "drain:environment:worker:2" });

      expect(outcome.state).toBe("acked");
      expect(outcome.threads).toEqual({ total: 2, acked: 2, failed: 0 });
      // The changed thread is fetched and written again under the new generation.
      expect(retry.fetched).toEqual(["thread:a", "thread:b"]);
      expect(retry.written.map((entry) => entry.threadId)).toEqual(["thread:a", "thread:b"]);
    }),
  );

  it.effect("never trusts copies left under its own drain id or with a stale marker", () =>
    Effect.gen(function* () {
      // A timed-out run leaves a stale copy under the previous generation and a
      // fresh-looking one under the id this retry runs under; neither may count.
      const dependencies = deps({
        threads: ["thread:a"],
        sequences: { "thread:a": 7 },
        seeded: [
          {
            drainId: "drain:environment:worker:1",
            threadId: "thread:a",
            snapshotSequence: 3,
            attachments: true,
          },
          {
            drainId: "drain:environment:worker:2",
            threadId: "thread:a",
            snapshotSequence: 7,
            attachments: true,
          },
        ],
      });
      const outcome = yield* drain(dependencies, { drainId: "drain:environment:worker:2" });

      expect(outcome.state).toBe("acked");
      expect(dependencies.fetched).toEqual(["thread:a"]);
      expect(dependencies.written.map((entry) => entry.drainId)).toEqual([
        "drain:environment:worker:2",
      ]);
    }),
  );

  it.effect("a timed-out generation still writing cannot corrupt the retry", () =>
    Effect.gen(function* () {
      const base = deps({
        threads: ["thread:a"],
        sequences: { "thread:a": 7 },
        seeded: [
          {
            drainId: "drain:environment:worker:1",
            threadId: "thread:a",
            snapshotSequence: 3,
            attachments: true,
          },
        ],
      });
      const sinkWrite = base.sink.write;
      // While generation 2 runs, the abandoned generation 1 finishes its own
      // (newer) copy into generation 1's directory.
      const lateWriter = {
        ...base.sink,
        write: (input: Parameters<typeof sinkWrite>[0]) =>
          sinkWrite(input).pipe(
            Effect.tap(() =>
              sinkWrite({ ...input, drainId: "drain:environment:worker:1", body: '{"late":true}' }),
            ),
          ),
      };
      const outcome = yield* drain(
        { ...base, sink: lateWriter },
        {
          drainId: "drain:environment:worker:2",
        },
      );

      // The stale generation 1 copy was re-fetched, written under generation 2's
      // own id, and verified against that copy — the late generation 1 write,
      // which lands in a directory the retry never reads, cannot satisfy it.
      expect(outcome.state).toBe("acked");
      expect(base.written.map((entry) => [entry.drainId, entry.threadId])).toEqual([
        ["drain:environment:worker:2", "thread:a"],
        ["drain:environment:worker:1", "thread:a"],
      ]);
    }),
  );

  it.effect("keeps the sandbox when a thread cannot be copied", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a", "thread:b"], failThread: "thread:b" });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("failed");
      expect(outcome.threads).toEqual({ total: 2, acked: 1, failed: 1 });
    }),
  );

  it.effect("refuses to drain a worker whose child is still working", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a"], liveThread: "thread:a" });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("failed");
      expect(outcome.finishedAt).toBeNull();
      expect(outcome.threads.failed).toBe(1);
      expect(dependencies.written).toHaveLength(0);
    }),
  );

  it.effect("keeps the sandbox when a checkout was not pushed", () =>
    Effect.gen(function* () {
      const dependencies = deps({
        threads: ["thread:a"],
        projects: ["/work/a"],
        pushExitCode: 1,
      });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("failed");
      expect(outcome.worktrees).toEqual({ total: 1, acked: 0, failed: 1 });
    }),
  );

  it.effect("stops at the deadline instead of claiming a partial drain", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a", "thread:b"], now: 5_000 });
      const outcome = yield* drain(dependencies, { deadlineAt: 1_000 });

      expect(outcome.state).toBe("failed");
      expect(outcome.threads).toEqual({ total: 0, acked: 0, failed: 0 });
      expect(dependencies.written).toHaveLength(0);
    }),
  );

  it.effect("copies threads but skips pushes for a forced removal", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a"], projects: ["/work/a"] });
      const outcome = yield* drain(dependencies, { snapshotOnly: true });

      expect(outcome.state).toBe("acked");
      expect(outcome.threads.acked).toBe(1);
      expect(dependencies.pushed).toHaveLength(0);
    }),
  );

  it.effect("drains attachments with the thread and verifies the manifest", () =>
    Effect.gen(function* () {
      const dependencies = deps({
        threads: ["thread:a"],
        attachmentFiles: { "thread:a": ["shot.png", "log.txt"] },
      });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("acked");
      expect(dependencies.fetchedAttachments).toEqual(["thread:a"]);
      expect(dependencies.written).toHaveLength(1);
    }),
  );

  it.effect("notes an oversize skip in the outcome without failing the drain", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a"], oversizeThreads: ["thread:a"] });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("acked");
      expect(outcome.warnings).toEqual([
        "Attachments of thread:a exceeded the drain size cap and were skipped.",
      ]);
    }),
  );

  it.effect("re-copies a thread whose previous copy predates attachment draining", () =>
    Effect.gen(function* () {
      const first = deps({ threads: ["thread:a"] });
      yield* drain(first, { drainId: "drain:environment:worker:1" });
      const retry = deps({
        threads: ["thread:a"],
        attachmentFiles: { "thread:a": ["late.bin"] },
        // The old copy carries no attachment manifest.
        seeded: first.written.map((entry) => ({
          drainId: "drain:environment:worker:1",
          threadId: entry.threadId,
          snapshotSequence: 1,
        })),
      });
      const outcome = yield* drain(retry, { drainId: "drain:environment:worker:2" });

      expect(outcome.state).toBe("acked");
      expect(retry.fetched).toEqual(["thread:a"]);
    }),
  );

  it.effect("fails the copy when the stored manifest does not match what was sent", () =>
    Effect.gen(function* () {
      const dependencies = deps({
        threads: ["thread:a"],
        attachmentFiles: { "thread:a": ["shot.png"] },
        dropAttachmentManifest: true,
      });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("failed");
      expect(outcome.threads).toEqual({ total: 1, acked: 0, failed: 1 });
    }),
  );
});
