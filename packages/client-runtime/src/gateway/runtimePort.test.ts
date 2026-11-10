import {
  DEFAULT_SERVER_SETTINGS,
  WS_METHODS,
  type OrchestrationV2ThreadLaunchInput,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type ServerProvider,
  type OrchestrationV2Command,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import {
  v2Project,
  v2Projection,
  v2ThreadShell,
  v2Now,
} from "../state/orchestrationV2TestFixtures.ts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createGatewayRuntimePort,
  createGatewayRuntimePortFromContext,
  gatewayEventFromV2,
  resolveGatewayProfileModelSelection,
  gatewayThreadProjection,
  gatewayStatusFromThread,
  resolveGatewayDevice,
} from "./runtimePort.ts";

const environmentId = EnvironmentId.make("remote-1");
const testCrypto = SecureRandom.make((size) => new Uint8Array(size));

describe("Gateway Runtime Port", () => {
  it.effect.each(["listProjects", "getThread"] as const)(
    "interrupts an offline %s snapshot after the request deadline",
    (operation) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let released = false;
        const registry = EnvironmentRegistry.of({
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
        } as unknown as EnvironmentRegistry["Service"]);
        const context = yield* Effect.context<
          EnvironmentRegistry | SecureRandom.SecureRandom
        >().pipe(
          Effect.provideService(EnvironmentRegistry, registry),
          Effect.provideService(SecureRandom.SecureRandom, testCrypto),
        );
        const port = createGatewayRuntimePortFromContext(context);
        const request = yield* Effect.promise(async (): Promise<unknown> =>
          operation === "listProjects"
            ? port.listProjects(environmentId)
            : port.getThread(environmentId, "offline-thread"),
        ).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("21 seconds");
        const result = yield* Fiber.join(request);
        expect(result._tag).toBe("Failure");
        expect(released).toBe(true);
      }),
  );
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

  it("exposes V2 association and bounded messages without provider session secrets", () => {
    const profileSnapshot = {
      profileId: "code",
      profileName: "Cody",
      revision: 1,
      contentHash: "sha256:code",
      effectiveSource: {
        modelSelection: "profile",
        runtimeMode: "profile",
        interactionMode: "profile",
        reasoningEffort: "profile",
      },
    } as const;
    const result = gatewayThreadProjection({
      ...v2Projection,
      thread: { ...v2Projection.thread, profileSnapshot },
      messages: [
        {
          id: MessageId.make("message"),
          threadId: v2Projection.thread.id,
          runId: null,
          nodeId: null,
          role: "user",
          text: "x".repeat(120_100),
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: v2Now,
          updatedAt: v2Now,
        },
      ],
    });
    expect(result.profileSnapshot?.profileId).toBe("code");
    expect(result.messages[0]?.text).toHaveLength(120_000);
    expect(result).not.toHaveProperty("providerSessions");
  });

  it("keeps identical thread IDs on different machines distinct in V2 events", () => {
    const update = {
      kind: "thread.updated",
      sequence: 7,
      location: "active",
      thread: v2ThreadShell,
    } as const;
    const local = gatewayEventFromV2(EnvironmentId.make("local"), update)!;
    const remote = gatewayEventFromV2(EnvironmentId.make("remote"), update)!;
    expect(local.eventId).not.toBe(remote.eventId);
    expect(local.threadId).toBe(remote.threadId);
    expect(remote.environmentId).toBe("remote");
    expect(remote.sequence).toBe(7);
    expect(remote.data).toMatchObject({ projectId: v2ThreadShell.projectId });
  });

  it.each([
    ["preparing", "queued"],
    ["starting", "queued"],
    ["running", "running"],
    ["failed", "failed"],
    ["cancelled", "stopped"],
    ["rolled_back", "stopped"],
    ["waiting", "running"],
    ["completed", "completed"],
  ] as const)("maps V2 %s to %s", (status, expected) => {
    expect(gatewayStatusFromThread({ status, pendingRuntimeRequest: null })).toBe(expected);
  });

  it.effect.each(["listProjects", "getThread"] as const)(
    "interrupts an offline %s snapshot subscription at its deadline",
    (operation) =>
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
        const port = yield* Effect.context<EnvironmentRegistry | SecureRandom.SecureRandom>().pipe(
          Effect.map(createGatewayRuntimePortFromContext),
          Effect.provideService(EnvironmentRegistry, registry),
          Effect.provideService(SecureRandom.SecureRandom, testCrypto),
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
        const context = yield* Effect.context<EnvironmentRegistry | SecureRandom.SecureRandom>();
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
        Effect.provideService(SecureRandom.SecureRandom, testCrypto),
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
          ...v2ThreadShell,
          id: "chat",
          projectId: "project",
          profileSnapshot: { profileId: "code" },
          title: "Done",
          settledAt: DateTime.makeUnsafe("2026-09-07T00:00:00.000Z"),
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

it.effect(
  "routes V2 reads and message commands through the selected machine even when thread IDs collide",
  () =>
    Effect.gen(function* () {
      const writes: Array<{ environmentId: string; command: OrchestrationV2Command }> = [];
      const launches: Array<{ environmentId: string; input: OrchestrationV2ThreadLaunchInput }> =
        [];
      const supervisors = new Map<string, EnvironmentSupervisor["Service"]>();
      const repositoryIdentity = {
        canonicalKey: "github.com/acme/app",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@x:acme/app",
        },
        owner: "acme",
        name: "app",
      };
      for (const environmentId of ["machine-a", "machine-b"]) {
        const session = yield* SubscriptionRef.make(
          Option.some({
            initialConfig: Effect.succeed({
              environment: { capabilities: { serverResolvedCommandContext: true } },
            }),
            client: {
              [WS_METHODS.serverGetConfig]: () =>
                Effect.succeed({ providers: [], settings: DEFAULT_SERVER_SETTINGS }),
              [ORCHESTRATION_V2_WS_METHODS.launchThread]: (
                input: OrchestrationV2ThreadLaunchInput,
              ) =>
                Effect.sync(() => {
                  launches.push({ environmentId, input });
                  return { threadId: input.threadId, projection: v2Projection, resumed: false };
                }),
              [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
                Stream.make({
                  kind: "snapshot",
                  snapshot: {
                    threads: [{ ...v2ThreadShell, title: environmentId }],
                    projects: [{ ...v2Project, repositoryIdentity }],
                  },
                }),
              [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
                Effect.sync(() => {
                  writes.push({ environmentId, command });
                  return { sequence: 1, storedEvents: [] };
                }),
            },
          }),
        );
        supervisors.set(environmentId, {
          target: { environmentId: EnvironmentId.make(environmentId), label: environmentId },
          session,
        } as unknown as EnvironmentSupervisor["Service"]);
      }
      const registry = {
        run: <A, E>(id: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) => {
          const supervisor = supervisors.get(id);
          return supervisor
            ? effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor))
            : Effect.die("Unknown environment");
        },
      } as unknown as EnvironmentRegistry["Service"];
      yield* Effect.gen(function* () {
        const context = yield* Effect.context<EnvironmentRegistry | SecureRandom.SecureRandom>();
        const port = createGatewayRuntimePortFromContext(context);
        expect((yield* Effect.promise(() => port.listThreads("machine-b"))).items[0]?.title).toBe(
          "machine-b",
        );
        // Git and pull request tools need the project's repository identity.
        expect(
          (yield* Effect.promise(() => port.listProjects("machine-b"))).items[0]
            ?.repositoryIdentity,
        ).toEqual(repositoryIdentity);
        yield* Effect.promise(() =>
          port.sendMessage({
            environmentId: "machine-b",
            threadId: v2ThreadShell.id,
            requestId: "routed-command",
            messageId: "routed-message",
            text: "Remote follow-up",
          }),
        );
        yield* Effect.promise(() =>
          port.createThread({
            environmentId: "machine-b",
            projectId: "shared-project",
            threadId: "shared-thread",
            title: "Worktree test",
            requestId: "launch-test",
            workspaceMode: "worktree",
            baseBranch: "main",
            modelSelection: { instanceId: "codex", model: "test" },
          }),
        );
        expect(launches).toEqual([
          {
            environmentId: "machine-b",
            input: expect.objectContaining({
              projectId: "shared-project",
              threadId: "shared-thread",
              workspaceStrategy: { type: "worktree", baseRef: "main" },
            }),
          },
        ]);
        expect(writes).toEqual([
          {
            environmentId: "machine-b",
            command: expect.objectContaining({
              type: "message.dispatch",
              threadId: v2ThreadShell.id,
              text: "Remote follow-up",
            }),
          },
        ]);
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(SecureRandom.SecureRandom, testCrypto),
      );
    }),
);

describe("resolveGatewayDevice", () => {
  const device = (deviceId: string, label: string) => ({
    deviceId,
    label,
    kind: "desktop" as const,
    visible: true,
    focused: false,
    connectedAt: "2026-09-23T00:00:00.000Z",
  });
  const devices = [device("mac", "Studio Mac"), device("win-1", "PC"), device("win-2", "PC")];

  it("accepts a deviceId or a unique label, ignoring case", () => {
    expect(resolveGatewayDevice(devices, "win-2").deviceId).toBe("win-2");
    expect(resolveGatewayDevice(devices, "studio mac").deviceId).toBe("mac");
  });

  it("names the connected devices when the choice is ambiguous or missing", () => {
    expect(() => resolveGatewayDevice(devices, "pc")).toThrow(/Several devices.*win-1.*win-2/);
    expect(() => resolveGatewayDevice(devices, "iPhone")).toThrow(/not connected.*Studio Mac/);
  });
});

describe("gateway pending questions", () => {
  it("projects a waiting question with its options for MCP answers", () => {
    const requestId = RuntimeRequestId.make("question-1");
    const nodeId = NodeId.make("question-node");
    const projected = gatewayThreadProjection({
      ...v2Projection,
      runtimeRequests: [
        {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: v2Now,
          resolvedAt: null,
        },
      ],
      turnItems: [
        {
          id: TurnItemId.make("question-item"),
          threadId: v2Projection.thread.id,
          runId: null,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: v2Now,
          completedAt: v2Now,
          updatedAt: v2Now,
          type: "user_input_request",
          requestId,
          questions: [
            {
              id: "target",
              header: "Target",
              question: "Which environment?",
              allowCustomAnswer: false,
              options: [{ label: "Staging", value: "staging", description: "Safe first" }],
            },
          ],
        },
      ],
    });
    expect(projected.hasPendingUserInput).toBe(true);
    expect(projected.pendingQuestions).toEqual([
      {
        questionRequestId: "question-1",
        askedAt: DateTime.formatIso(v2Now),
        questions: [
          {
            questionId: "target",
            header: "Target",
            question: "Which environment?",
            multiSelect: false,
            allowsFreeText: false,
            options: [{ label: "Staging", description: "Safe first", value: "staging" }],
          },
        ],
      },
    ]);
  });

  it("projects a pending approval with the prompt the composer shows", () => {
    const requestId = RuntimeRequestId.make("approval-1");
    const nodeId = NodeId.make("approval-node");
    const projected = gatewayThreadProjection({
      ...v2Projection,
      runtimeRequests: [
        {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("s") },
          createdAt: v2Now,
          resolvedAt: null,
        },
      ],
      turnItems: [
        {
          id: TurnItemId.make("approval-item"),
          threadId: v2Projection.thread.id,
          runId: null,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "running",
          title: null,
          startedAt: v2Now,
          completedAt: null,
          updatedAt: v2Now,
          type: "approval_request",
          requestId,
          requestKind: "command",
          prompt: "rm -rf build",
        },
      ],
    });
    expect(projected.hasPendingApprovals).toBe(true);
    expect(projected.pendingApprovals).toEqual([
      {
        requestId: "approval-1",
        requestKind: "command",
        createdAt: DateTime.formatIso(v2Now),
        detail: "rm -rf build",
      },
    ]);
  });
});
