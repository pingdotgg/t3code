import {
  CommandId,
  PiNativeRuntimeId,
  PiNativeSessionKey,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  associate,
  boundExternalCatalog,
  catalogUpdateAfterRead,
  CatalogRuntimeAttachmentGate,
  runtimeSnapshotAtSequence,
  runtimeSequenceStable,
  runtimeCatalogSignature,
  isRuntimeLifecycleEvent,
  managedPiBindingSignature,
  receiptSessionFile,
  resolveManagedPiParentThreadIds,
  shutdownCreatedRuntime,
  validExternalLifecycleOverride,
} from "./PiExternalThreadSource.ts";
import type { SupervisorRuntimeState } from "./SupervisorProtocol.ts";

describe("PiExternalThreadSource hardening", () => {
  it.effect("shuts down a newly created runtime when session cataloging fails", () =>
    Effect.gen(function* () {
      const commands: unknown[] = [];
      yield* shutdownCreatedRuntime(
        {
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({
              commandId: CommandId.make("cleanup-receipt"),
              status: "completed",
              runtimeId: PiNativeRuntimeId.make("runtime-1"),
            });
          },
        },
        PiNativeRuntimeId.make("runtime-1"),
      );

      expect(commands).toMatchObject([{ type: "shutdown", runtimeId: "runtime-1" }]);
    }),
  );

  it("uses the latest runtime state for state-bearing stream snapshots", () => {
    const capturedAtSubscription = {
      runtimeId: PiNativeRuntimeId.make("runtime-1"),
      writerKind: "rpc",
      status: "idle",
      sequence: 1,
    } satisfies SupervisorRuntimeState;
    const current = {
      runtimeId: PiNativeRuntimeId.make("runtime-1"),
      writerKind: "rpc",
      status: "streaming",
      sequence: 7,
    } satisfies SupervisorRuntimeState;

    expect(runtimeSnapshotAtSequence(current, 9)).toMatchObject({
      status: "streaming",
      sequence: 9,
    });
    expect(capturedAtSubscription.status).toBe("idle");
    expect(runtimeSequenceStable(capturedAtSubscription, current)).toBe(false);
    expect(runtimeSequenceStable(current, { ...current })).toBe(true);
  });

  it("stops catalog replacements after a runtime attaches", () => {
    const gate = new CatalogRuntimeAttachmentGate();
    expect(gate.allowsCatalogUpdate()).toBe(true);
    gate.attach();
    expect(gate.allowsCatalogUpdate()).toBe(false);
    expect(catalogUpdateAfterRead(gate, { snapshotSequence: 1 })).toBeUndefined();
  });

  it("refreshes state for bridge disconnect and reconnect lifecycle events", () => {
    expect(isRuntimeLifecycleEvent("bridge_disconnected")).toBe(true);
    expect(isRuntimeLifecycleEvent("bridge_reconnected")).toBe(true);
    expect(isRuntimeLifecycleEvent("message_update")).toBe(false);
  });

  it("recovers a created session after its runtime is evicted", () => {
    expect(
      receiptSessionFile({
        commandId: "create-1" as never,
        status: "completed",
        runtimeId: "evicted" as never,
        result: { sessionFile: "/sessions/created.jsonl" },
      }),
    ).toBe("/sessions/created.jsonl");
  });

  it("rebuilds catalog shells only when runtime-visible state changes", () => {
    const runtime = {
      runtimeId: PiNativeRuntimeId.make("runtime-1"),
      sessionFile: "/sessions/one.jsonl",
      writerKind: "rpc",
      status: "streaming",
      sequence: 4,
    } satisfies SupervisorRuntimeState;

    expect(runtimeCatalogSignature([{ ...runtime, sequence: 5 }])).toBe(
      runtimeCatalogSignature([runtime]),
    );
    expect(runtimeCatalogSignature([{ ...runtime, status: "idle" }])).not.toBe(
      runtimeCatalogSignature([runtime]),
    );
  });

  it.effect("associates Pi sessions only with projects the user added", () =>
    Effect.gen(function* () {
      const session = (name: string, cwd: string) =>
        ({
          sourceKey: PiNativeSessionKey.make(`${name}-source`),
          threadId: ThreadId.make(`external:pi:path:${name}`),
          canonicalFile: `/sessions/${name}.jsonl`,
          sessionId: `${name}-session`,
          cwd,
          title: name,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:01:00.000Z",
          fileSize: 1,
          fileMtimeMs: 1,
          historyTruncation: { truncated: false },
        }) as const;
      const projectId = ProjectId.make("project-1");
      const worktreeProjectId = ProjectId.make("project-2");

      const association = yield* Effect.promise(() =>
        associate(
          [
            session("root", "/workspace/app"),
            session("nested", "/workspace/app/packages/ui"),
            session("worktree", "/worktrees/feature"),
            session("foreign", "/tmp"),
            session("sibling", "/workspace/app-two"),
          ],
          {
            snapshotSequence: 1,
            projects: [{ id: projectId, workspaceRoot: "/workspace/app" }],
            threads: [{ projectId: worktreeProjectId, worktreePath: "/worktrees/feature" }],
            updatedAt: "2026-08-06T00:01:00.000Z",
          } as never,
        ),
      );

      expect(Object.fromEntries(association.projectIdByThread)).toEqual({
        "external:pi:path:root": projectId,
        "external:pi:path:nested": projectId,
        "external:pi:path:worktree": worktreeProjectId,
      });
    }),
  );

  it.effect("places delegated Pi sessions under their managed T3 parent", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread-parent");
      const child = {
        sourceKey: PiNativeSessionKey.make("child-source"),
        threadId: ThreadId.make("external:pi:path:child"),
        canonicalFile: "/sessions/child.jsonl",
        sessionId: "child-session",
        parentSessionFile: "/managed/parent.jsonl",
        parentThreadId: ThreadId.make("external:pi:path:missing-parent"),
        cwd: "/workspace",
        title: "child",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:01:00.000Z",
        fileSize: 1,
        fileMtimeMs: 1,
        historyTruncation: { truncated: false },
      } as const;

      const resolved = yield* Effect.promise(() =>
        resolveManagedPiParentThreadIds(
          [child],
          [
            {
              threadId: parentThreadId,
              provider: ProviderDriverKind.make("pi"),
              resumeCursor: {
                schemaVersion: 1,
                sessionFile: "/managed/parent.jsonl",
                sessionId: "parent-session",
              },
              lastSeenAt: "2026-08-06T00:01:00.000Z",
            },
          ],
        ),
      );

      expect(resolved[0]?.parentThreadId).toBe(parentThreadId);
      expect(resolved[0]?.parentSessionFile).toBe(child.parentSessionFile);
    }),
  );

  it("invalidates the catalog when a managed Pi parent binding appears", () => {
    const binding = {
      threadId: ThreadId.make("thread-parent"),
      provider: ProviderDriverKind.make("pi"),
      resumeCursor: {
        schemaVersion: 1,
        sessionFile: "/managed/parent.jsonl",
        sessionId: "parent-session",
      },
      lastSeenAt: "2026-08-06T00:01:00.000Z",
    } as const;

    expect(managedPiBindingSignature([binding])).not.toBe(managedPiBindingSignature([]));
    expect(managedPiBindingSignature([{ ...binding, lastSeenAt: "later" }])).toBe(
      managedPiBindingSignature([binding]),
    );
  });

  it("invalidates a lifecycle override after the Pi session file changes", () => {
    const record = {
      sourceKey: PiNativeSessionKey.make("source"),
      threadId: ThreadId.make("external:pi:path:source"),
      canonicalFile: "/sessions/source.jsonl",
      sessionId: "session",
      cwd: "/workspace",
      title: "session",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:01:00.000Z",
      fileSize: 10,
      fileMtimeMs: 20,
      historyTruncation: { truncated: false },
    } as const;
    const override = {
      sourceKey: record.sourceKey,
      commandId: CommandId.make("settle"),
      lifecycleOverride: "settled" as const,
      observedFileSize: 10,
      observedFileMtimeMs: 20,
      updatedAt: "2026-08-06T00:01:00.000Z",
    };

    expect(validExternalLifecycleOverride(record, override)?.override).toBe("settled");
    expect(validExternalLifecycleOverride({ ...record, fileSize: 11 }, override)).toBeUndefined();
    expect(
      validExternalLifecycleOverride(
        {
          ...record,
          fileSize: 11,
          jsonlLifecycle: {
            override: "active",
            operationId: "pi-operation",
            updatedAt: "2026-08-06T00:02:00.000Z",
          },
        },
        override,
      )?.override,
    ).toBe("active");
  });

  it("bounds aggregate catalog records and serialized bytes with omission counts", () => {
    const threads = Array.from({ length: 20 }, (_, index) => ({
      id: ThreadId.make(`external:pi:${index}`),
      projectId: ProjectId.make("project-1"),
      title: "x".repeat(256),
    })) as unknown as OrchestrationThreadShell[];

    const bounded = boundExternalCatalog({
      threads,
      totalThreadCount: threads.length,
      maxThreads: 10,
      maxSerializedBytes: 1_500,
    });

    expect(bounded.threads.length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(JSON.stringify(bounded)) + 1_024).toBeLessThanOrEqual(1_500);
    expect(bounded.omittedThreadCount).toBe(threads.length - bounded.threads.length);
  });
});
