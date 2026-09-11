import { EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  approvalResponsesFromModifications,
  createGatewayRuntimePort,
  createGatewayRuntimePortFromContext,
  enrichGatewayRuntimeEventStream,
  gatewayEventFromOrchestration,
  resolveGatewayProfileModelSelection,
  gatewayThreadProjection,
  gatewayStatusFromThread,
} from "./runtimePort.ts";

const environmentId = EnvironmentId.make("remote-1");
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

describe("Gateway Runtime Port", () => {
  it("resolves readable labels only when one live provider/model pair matches", () => {
    const profile = {
      profileId: "profile-andy",
      name: "Andy",
      providerLabel: "Codex",
      modelLabel: "GPT-5.6 Sol",
      runtimeMode: "approval-required",
      interactionMode: "default",
      revision: 1,
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    } as const;
    const provider = {
      instanceId: "codex-main",
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      availability: "available",
      status: "ready",
      models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    } as unknown as ServerProvider;

    expect(resolveGatewayProfileModelSelection(profile, [provider])).toEqual({
      instanceId: "codex-main",
      model: "gpt-5.6-sol",
    });
    expect(resolveGatewayProfileModelSelection(profile, [provider, provider])).toBeUndefined();
    expect(
      resolveGatewayProfileModelSelection(profile, [{ ...provider, status: "error" }]),
    ).toBeUndefined();
    expect(
      resolveGatewayProfileModelSelection(profile, [{ ...provider, status: "disabled" }]),
    ).toBeUndefined();
    expect(
      resolveGatewayProfileModelSelection(profile, [{ ...provider, enabled: false } as never]),
    ).toBeUndefined();
    expect(
      resolveGatewayProfileModelSelection(profile, [
        { ...provider, models: [{ slug: "other", name: "Other" }] } as never,
      ]),
    ).toBeUndefined();
  });

  it("routes custom OpenCode models by slug when display names collide", () => {
    const provider = {
      instanceId: "opencode",
      driver: "opencode",
      displayName: "OpenCode",
      enabled: true,
      availability: "available",
      status: "ready",
      models: [
        { slug: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
        { slug: "deepseek-api/deepseek-flash", name: "DeepSeek Flash" },
      ],
    } as unknown as ServerProvider;
    expect(
      resolveGatewayProfileModelSelection(
        { providerLabel: "OpenCode", modelLabel: "deepseek-api/deepseek-flash" },
        [provider],
      ),
    ).toEqual({ instanceId: "opencode", model: "deepseek-api/deepseek-flash" });
    expect(
      resolveGatewayProfileModelSelection(
        { providerLabel: "OpenCode", modelLabel: "DeepSeek Flash" },
        [provider],
      ),
    ).toBeUndefined();
  });

  it("validates legacy routing snapshots against the live catalog and preserves options", () => {
    const selection = {
      instanceId: "codex-main",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    };
    const profile = { modelSelection: selection };
    const provider = {
      instanceId: "codex-main",
      driver: "codex",
      enabled: true,
      availability: "available",
      status: "ready",
      models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    } as unknown as ServerProvider;

    expect(resolveGatewayProfileModelSelection(profile, [provider])).toEqual(selection);
    for (const providers of [
      [],
      [{ ...provider, instanceId: "another-instance" }],
      [{ ...provider, status: "error" }],
      [{ ...provider, status: "disabled" }],
      [{ ...provider, enabled: false }],
      [{ ...provider, availability: "unavailable" }],
      [{ ...provider, models: [] }],
    ]) {
      expect(
        resolveGatewayProfileModelSelection(profile, providers as ReadonlyArray<ServerProvider>),
      ).toBeUndefined();
    }
  });

  it("projects bounded authoritative lifecycle metadata without leaking raw activity payloads", () => {
    const projected = gatewayEventFromOrchestration(
      environmentId,
      {
        eventId: "event-1",
        sequence: 4,
        occurredAt: "2026-09-04T00:00:00.000Z",
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        correlationId: "corr-1",
        payload: {
          activity: {
            kind: "approval.requested",
            summary: "Approval required for two file changes",
            payload: {
              requestId: "approval-1",
              providerOutput: "secret output",
              hostPath: "/home/user/private",
              detail: "provider said secret output from /home/user/private",
            },
          },
        },
      } as never,
      {
        machine: "Build machine",
        project: { id: "project-1", title: "T3 Code" },
        thread: { title: "Fix gateway", status: "waiting-approval" },
      },
    );

    expect(projected).toMatchObject({
      environmentId: "remote-1",
      type: "approval.requested",
      threadId: "thread-1",
      data: {
        machine: "Build machine",
        project: { id: "project-1", title: "T3 Code" },
        threadTitle: "Fix gateway",
        status: "waiting-approval",
        summary: "Approval required for two file changes",
        nextAction: "approve_actions",
        blocker: { kind: "approval", requestId: "approval-1" },
        serverSequence: 4,
        serverEventType: "thread.activity-appended",
        activityKind: "approval.requested",
        requestId: "approval-1",
      },
    });
    expect(JSON.stringify(projected)).not.toContain("secret output");
    expect(JSON.stringify(projected)).not.toContain("/home/user/private");
  });

  it.effect("refreshes create, rename, and status context after an event stream starts", () =>
    Effect.gen(function* () {
      const snapshot = (sequence: number, title: string, status: "queued" | "running") =>
        ({
          snapshotSequence: sequence,
          projects: [{ id: "project-1", title: "T3 Code" }],
          threads: [
            {
              id: "thread-1",
              projectId: "project-1",
              title,
              latestTurn: status === "running" ? { state: "running" } : null,
              session: null,
            },
          ],
          updatedAt: `2026-09-04T00:00:0${sequence}.000Z`,
        }) as never;
      const snapshots = [
        snapshot(1, "Initial title", "queued"),
        snapshot(2, "Renamed title", "queued"),
        snapshot(3, "Renamed title", "running"),
      ];
      const events = [
        {
          eventId: "event-create",
          sequence: 1,
          occurredAt: "2026-09-04T00:00:01.000Z",
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          correlationId: null,
          payload: { projectId: "project-1", title: "Initial title" },
        },
        {
          eventId: "event-rename",
          sequence: 2,
          occurredAt: "2026-09-04T00:00:02.000Z",
          type: "thread.meta-updated",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          correlationId: null,
          payload: { threadId: "thread-1", title: "Renamed title" },
        },
        {
          eventId: "event-status",
          sequence: 3,
          occurredAt: "2026-09-04T00:00:03.000Z",
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          correlationId: null,
          payload: {},
        },
      ] as const;
      const loadSnapshot = vi.fn((event: { readonly sequence: number }) =>
        Effect.succeed(snapshots[event.sequence - 1] as never),
      );

      const projected = yield* enrichGatewayRuntimeEventStream({
        environmentId,
        machine: "Build machine",
        initialSnapshot: {
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-09-04T00:00:00.000Z",
        } as never,
        events: Stream.fromIterable(events as never),
        loadSnapshot,
      }).pipe(Stream.runCollect);

      expect(Array.from(projected)).toMatchObject([
        {
          data: {
            project: { id: "project-1", title: "T3 Code" },
            threadTitle: "Initial title",
          },
        },
        { data: { threadTitle: "Renamed title" } },
        { data: { threadTitle: "Renamed title", status: "running" } },
      ]);
      expect(loadSnapshot).toHaveBeenCalledTimes(3);
    }),
  );

  it.each(["pause", "stop", "cancel"])(
    "does not report %s as finished from an acknowledgement",
    (action) => {
      const projected = gatewayEventFromOrchestration(
        environmentId,
        {
          eventId: "event-lifecycle-1",
          sequence: 5,
          occurredAt: "2026-09-04T00:00:01.000Z",
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          correlationId: null,
          payload: {
            activity: {
              kind: `lifecycle.${action}.completed`,
              summary: "Pause accepted",
              payload: { action: "pause", attemptId: "attempt-pause-1" },
            },
          },
        } as never,
        {
          machine: "Build machine",
          project: { id: "project-1", title: "T3 Code" },
          thread: { title: "Fix gateway", status: "running" },
        },
      );

      expect(projected).toMatchObject({
        type: "thread.progress",
        data: {
          status: "running",
          nextAction: "await_event",
          activityKind: `lifecycle.${action}.completed`,
        },
      });
    },
  );

  it.each([
    ["starting", "completed", null, "running"],
    ["running", "interrupted", null, "running"],
    ["stopped", "running", null, "stopped"],
    ["interrupted", "running", null, "interrupted"],
    ["ready", "completed", "2026-09-07T00:00:01.000Z", "queued"],
    ["stopped", "completed", "2026-09-07T00:00:01.000Z", "queued"],
    ["ready", "completed", null, "completed"],
    ["ready", null, null, "idle"],
  ] as const)(
    "reports %s session with %s turn and message %s as %s",
    (session, turn, messageAt, expected) => {
      expect(
        gatewayStatusFromThread(
          {
            session: { status: session },
            latestTurn:
              turn === null
                ? null
                : {
                    state: turn,
                    requestedAt: "2026-09-07T00:00:00.000Z",
                    startedAt: "2026-09-07T00:00:00.000Z",
                    completedAt: turn === "completed" ? "2026-09-07T00:00:00.500Z" : null,
                  },
            latestUserMessageAt: messageAt,
          } as Parameters<typeof gatewayStatusFromThread>[0],
          "2026-09-07T00:00:02.000Z",
        ),
      ).toBe(expected);
    },
  );

  it.each(["interrupted", "stopped"])("publishes observed %s session state", (status) => {
    const event = gatewayEventFromOrchestration(
      environmentId,
      {
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        eventId: "session-event",
        sequence: 6,
        occurredAt: "2026-09-07T00:00:02.000Z",
        correlationId: null,
        payload: {},
      } as never,
      { machine: "dev-box", thread: { title: "Audit", status } },
    );
    expect(event).toMatchObject({ type: "thread.state_changed", data: { status } });
  });

  it("redacts raw provider output and host paths before the bridge boundary", () => {
    const projected = gatewayEventFromOrchestration(environmentId, {
      eventId: "event-1",
      sequence: 4,
      occurredAt: "2026-09-04T00:00:00.000Z",
      type: "thread.activity-appended",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      correlationId: "corr-1",
      payload: {
        activity: {
          kind: "approval.requested",
          payload: {
            requestId: "approval-1",
            providerOutput: "secret output",
            hostPath: "/home/user/private",
            detail: "provider said secret output from /home/user/private",
          },
        },
      },
    } as never);

    expect(projected).toMatchObject({
      environmentId: "remote-1",
      type: "approval.requested",
      threadId: "thread-1",
      data: {
        serverSequence: 4,
        serverEventType: "thread.activity-appended",
        activityKind: "approval.requested",
        requestId: "approval-1",
      },
    });
    expect(projected.data).not.toHaveProperty("summary");
    expect(JSON.stringify(projected)).not.toContain("secret output");
    expect(JSON.stringify(projected)).not.toContain("/home/user/private");
  });

  it("converts approval modifications into one validated server batch", () => {
    expect(
      approvalResponsesFromModifications([
        { actionId: "approval-1", fields: { decision: "decline" } },
        { actionId: "approval-2", fields: { decision: "acceptForSession" } },
      ]),
    ).toEqual([
      { approvalRequestId: "approval-1", decision: "decline" },
      { approvalRequestId: "approval-2", decision: "acceptForSession" },
    ]);
    expect(() =>
      approvalResponsesFromModifications([
        { actionId: "approval-1", fields: { decision: "invalid" } },
      ]),
    ).toThrow("Invalid approval modification");
  });

  it("bounds thread DTOs and removes host-sensitive fields", () => {
    const projected = gatewayThreadProjection({
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      profileSnapshot: { profileId: "write", revision: 1 },
      settledAt: "2026-09-07T00:00:00.000Z",
      modelSelection: { instanceId: "codex", model: "gpt" },
      runtimeMode: "full-access",
      interactionMode: "default",
      latestTurn: null,
      session: {
        status: "running",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "provider failed at /home/user/secret",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      messages: [
        {
          id: "message-1",
          role: "assistant",
          text: "ok",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      activities: [
        {
          id: "activity-1",
          sequence: 1,
          turnId: null,
          tone: "tool",
          kind: "tool.completed",
          summary: "done",
          payload: { rawOutput: "secret", hostPath: "/home/user/secret" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      checkpoints: [],
      artifacts: [
        {
          artifactId: "workspace-turn-1-0",
          kind: "workspace-file",
          sourceId: "turn-1",
          name: "secret",
          path: "/home/user/secret",
          createdAt: "2026-01-01T00:00:00.000Z",
          availability: "available",
        },
        {
          artifactId: "workspace-turn-1-1",
          kind: "workspace-file",
          sourceId: "turn-1",
          name: "index.ts",
          path: "src/index.ts",
          createdAt: "2026-01-01T00:00:00.000Z",
          availability: "available",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(projected.settledAt).toBe("2026-09-07T00:00:00.000Z");
    expect(projected.profileSnapshot).toEqual({ profileId: "write", revision: 1 });

    expect(projected.session).not.toHaveProperty("lastError");
    expect(projected.activities[0]?.payload).toEqual({});
    expect(projected.artifacts).toHaveLength(1);
    expect(projected.artifacts[0]).toMatchObject({ path: "src/index.ts" });
    expect(JSON.stringify(projected)).not.toContain("/home/user/secret");
  });

  for (const operation of ["listProjects", "getThread"] as const) {
    it.effect(`interrupts an offline ${operation} snapshot subscription at its deadline`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const registry = {
          run: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(released, undefined)),
            ),
        } as unknown as EnvironmentRegistry["Service"];
        const port = yield* Effect.context<EnvironmentRegistry | Crypto.Crypto>().pipe(
          Effect.map(createGatewayRuntimePortFromContext),
          Effect.provideService(EnvironmentRegistry, registry),
          Effect.provideService(Crypto.Crypto, testCrypto),
        );
        const pending = (
          operation === "listProjects"
            ? port.listProjects(environmentId)
            : port.getThread(environmentId, "thread-1")
        ).then(
          () => false,
          () => true,
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("21 seconds");
        yield* Deferred.await(released);
        expect(yield* Effect.promise(() => pending)).toBe(true);
      }),
    );
  }

  it.effect("projects the existing registry without starting or replacing it", () =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make(
        new Map([
          [
            environmentId,
            {
              target: {
                _tag: "RelayConnectionTarget" as const,
                environmentId,
                label: "Build machine",
              },
              profile: { _tag: "None" as const },
            },
          ],
        ]),
      );
      const start = vi.fn(() => Effect.void);
      const registry = EnvironmentRegistry.of({
        entries,
        start,
        state: () =>
          Effect.succeed({
            desired: true,
            network: "online",
            phase: "connected",
            stage: null,
            attempt: 1,
            generation: 1,
            lastFailure: null,
            retryAt: null,
          }),
      } as unknown as EnvironmentRegistry["Service"]);

      yield* Effect.gen(function* () {
        const context = yield* Effect.context<EnvironmentRegistry | Crypto.Crypto>();
        const port = createGatewayRuntimePortFromContext(context);
        const result = yield* Effect.promise(() => port.listEnvironments());

        expect(result).toEqual([
          {
            environmentId: "remote-1",
            label: "Build machine",
            targetKind: "relay",
            connectionState: "connected",
          },
        ]);
        expect(start).not.toHaveBeenCalled();
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(Crypto.Crypto, testCrypto),
      );
    }),
  );
});
describe("opening a desktop chat", () => {
  it.each(["local", "remote"])(
    "validates the thread and awaits desktop navigation for %s",
    async (target) => {
      const navigation = Promise.withResolvers<void>();
      const open = vi.fn(() => navigation.promise);
      const runPromise = vi.fn(async () => ({ thread: { id: "chat", deletedAt: null } }));
      const port = createGatewayRuntimePort(
        { runPromise } as unknown as import("./runtimePort.ts").GatewayEffectRuntime,
        open,
      );
      let finished = false;
      const result = port.openThread(target, "chat").then((value) => {
        finished = true;
        return value;
      });
      await Promise.resolve();
      expect(runPromise).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(target, "chat");
      expect(finished).toBe(false);
      navigation.resolve();
      await expect(result).resolves.toEqual({
        environmentId: target,
        threadId: "chat",
        status: "succeeded",
      });
    },
  );

  it.each([
    { id: "other", deletedAt: null },
    { id: "chat", deletedAt: "2026-09-01" },
  ])("rejects an unavailable thread", async (thread) => {
    const open = vi.fn(async () => {});
    const port = createGatewayRuntimePort(
      {
        runPromise: async () => ({ thread }),
      } as unknown as import("./runtimePort.ts").GatewayEffectRuntime,
      open,
    );
    await expect(port.openThread("remote", "chat")).rejects.toThrow("not found");
    expect(open).not.toHaveBeenCalled();
  });

  it("propagates connection failure without navigating", async () => {
    const open = vi.fn(async () => {});
    const port = createGatewayRuntimePort(
      {
        runPromise: async () => {
          throw new Error("offline");
        },
      },
      open,
    );
    await expect(port.openThread("remote", "chat")).rejects.toThrow("offline");
    expect(open).not.toHaveBeenCalled();
  });
});

it("retains settlement state in the thread list used by agent filters", async () => {
  const port = createGatewayRuntimePort({
    runPromise: async () => ({
      threads: [
        {
          id: "chat",
          projectId: "project",
          profileSnapshot: { profileId: "code" },
          title: "Done",
          settledAt: "2026-09-07T00:00:00.000Z",
          session: null,
          latestTurn: null,
        },
      ],
      updatedAt: "now",
    }),
  } as unknown as import("./runtimePort.ts").GatewayEffectRuntime);
  expect(await port.listThreads("remote")).toMatchObject({
    items: [
      { id: "chat", settledAt: "2026-09-07T00:00:00.000Z", profileSnapshot: { profileId: "code" } },
    ],
  });
});
