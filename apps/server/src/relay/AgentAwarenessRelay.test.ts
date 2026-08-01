import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { CommandId, ProviderInstanceId } from "@t3tools/contracts";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { RELAY_ACTIVITY_PUBLISH_TYP, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FocusedDesktopClients from "../presence/FocusedDesktopClients.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
} from "../cloud/config.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-05-25T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};

const encodeSecret = (value: string): Uint8Array => new TextEncoder().encode(value);

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  const store = {
    get: ((name) =>
      Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["get"],
    set: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["set"],
    create: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["create"],
    getOrCreateRandom: ((name, bytes) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) {
          return existing;
        }
        const generated = new Uint8Array(bytes);
        values.set(name, generated);
        return generated;
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["getOrCreateRandom"],
    remove: ((name) =>
      Effect.sync(() => {
        values.delete(name);
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["remove"],
  } satisfies ServerSecretStore.ServerSecretStore["Service"];
  return {
    store,
    setString: (name: string, value: string) => store.set(name, encodeSecret(value)),
  };
}

describe.sequential("signRelayAgentActivityPublishProof", () => {
  it("distinguishes pending link credentials from disabled publication", () => {
    expect(
      AgentAwarenessRelay.resolveAgentActivityPublishingStartupState({
        relayConfigured: false,
        publishEnabled: false,
      }),
    ).toBe("waiting-for-link");
    expect(
      AgentAwarenessRelay.resolveAgentActivityPublishingStartupState({
        relayConfigured: true,
        publishEnabled: false,
      }),
    ).toBe("disabled");
    expect(
      AgentAwarenessRelay.resolveAgentActivityPublishingStartupState({
        relayConfigured: true,
        publishEnabled: true,
      }),
    ).toBe("enabled");
  });

  it("derives the thread id from the aggregate id for thread events without payload thread ids", () => {
    const threadId = "thread-aggregate-1" as ThreadId;
    const now = "2026-05-25T00:00:00.000Z";
    const event = {
      type: "thread.activity-appended",
      sequence: 1,
      eventId: "evt-aggregate-1",
      commandId: CommandId.make("cmd-1"),
      aggregateKind: "thread",
      aggregateId: threadId,
      actor: { kind: "server" },
      payload: {},
      occurredAt: now,
    } as unknown as OrchestrationEvent;

    expect(AgentAwarenessRelay.eventThreadId(event)).toBe(threadId);
  });

  it("does not publish start intents, streaming content, or non-awareness activity events", () => {
    const now = "2026-05-25T00:00:00.000Z";
    const base = {
      sequence: 1,
      eventId: "evt-1",
      commandId: CommandId.make("cmd-1"),
      aggregateKind: "thread",
      aggregateId: "thread-1" as ThreadId,
      occurredAt: now,
    };

    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1" as ThreadId,
          streaming: true,
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.activity-appended",
        payload: {
          threadId: "thread-1" as ThreadId,
          activity: {
            kind: "task.progress",
          },
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.activity-appended",
        payload: {
          threadId: "thread-1" as ThreadId,
          activity: {
            kind: "approval.requested",
          },
        },
      } as unknown as OrchestrationEvent),
    ).toBe(true);
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1" as ThreadId,
          streaming: false,
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.turn-start-requested",
        payload: {
          threadId: "thread-1" as ThreadId,
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
  });

  it("deduplicates awareness state updates whose only change is their event timestamp", () => {
    expect(AgentAwarenessRelay.agentAwarenessPublishIdentity(state)).toBe(
      AgentAwarenessRelay.agentAwarenessPublishIdentity({
        ...state,
        updatedAt: "2026-05-25T00:10:00.000Z",
      }),
    );
    expect(AgentAwarenessRelay.agentAwarenessPublishIdentity(state)).not.toBe(
      AgentAwarenessRelay.agentAwarenessPublishIdentity({
        ...state,
        phase: "completed",
        headline: "Agent finished",
      }),
    );
  });

  it("requires an explicit opt-in before publishing agent activity", () => {
    expect(AgentAwarenessRelay.isAgentActivityPublishingEnabled(null)).toBe(false);
    expect(AgentAwarenessRelay.isAgentActivityPublishingEnabled("false")).toBe(false);
    expect(AgentAwarenessRelay.isAgentActivityPublishingEnabled("true")).toBe(true);
  });

  it("redacts failed activity details and caps other relay detail", () => {
    expect(
      AgentAwarenessRelay.sanitizeRelayAgentActivityState({
        ...state,
        phase: "failed",
        detail: "Provider process exited with secret token.",
      }),
    ).toMatchObject({
      phase: "failed",
      detail: "The agent run failed.",
    });
    expect(
      AgentAwarenessRelay.sanitizeRelayAgentActivityState({
        ...state,
        detail: "x".repeat(200),
      })?.detail,
    ).toHaveLength(160);
  });

  it("restores only non-terminal activity after desktop focus ends", () => {
    expect(
      AgentAwarenessRelay.isAgentAwarenessResumableAfterDesktopFocus({
        ...state,
        phase: "running",
      }),
    ).toBe(true);
    expect(
      AgentAwarenessRelay.isAgentAwarenessResumableAfterDesktopFocus({
        ...state,
        phase: "waiting_for_approval",
      }),
    ).toBe(true);
    expect(
      AgentAwarenessRelay.isAgentAwarenessResumableAfterDesktopFocus({
        ...state,
        phase: "completed",
      }),
    ).toBe(false);
    expect(
      AgentAwarenessRelay.isAgentAwarenessResumableAfterDesktopFocus({
        ...state,
        phase: "failed",
      }),
    ).toBe(false);
    expect(AgentAwarenessRelay.isAgentAwarenessResumableAfterDesktopFocus(null)).toBe(false);
  });

  it("resolves a null publish state when a thread or project snapshot disappeared", () => {
    const environmentId = "env-1" as EnvironmentId;
    const threadId = "thread-1" as ThreadId;
    const thread = {
      id: threadId,
      projectId: "project-1" as ProjectId,
      title: "Deleted thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      session: null,
      latestTurn: null,
      updatedAt: "2026-05-25T00:00:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    } as OrchestrationThreadShell;

    expect(
      AgentAwarenessRelay.resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId,
        thread: Option.none(),
        project: Option.none(),
      }),
    ).toEqual({
      projectId: null,
      state: null,
      reason: "thread-not-found",
    });

    expect(
      AgentAwarenessRelay.resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId,
        thread: Option.some(thread),
        project: Option.none(),
      }),
    ).toEqual({
      projectId: "project-1",
      state: null,
      reason: "project-not-found",
    });
  });

  it("selects only active shell snapshot threads for startup catch-up", () => {
    const now = "2026-05-25T00:00:00.000Z";
    const environmentId = "env-1" as EnvironmentId;
    const projectId = "project-1" as ProjectId;
    const activeThreadId = "thread-active" as ThreadId;
    const idleThreadId = "thread-idle" as ThreadId;

    const baseThread = {
      projectId,
      title: "Run remote agent",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies Omit<OrchestrationThreadShell, "id">;

    expect(
      AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
        environmentId,
        projects: [
          {
            id: projectId,
            title: "T3 Code",
          },
        ],
        threads: [
          {
            ...baseThread,
            id: activeThreadId,
            latestTurn: {
              turnId: "turn-1" as TurnId,
              state: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              assistantMessageId: null,
            },
          },
          {
            ...baseThread,
            id: idleThreadId,
          },
          {
            ...baseThread,
            id: "thread-missing-project" as ThreadId,
            projectId: "missing-project" as ProjectId,
            latestTurn: {
              turnId: "turn-2" as TurnId,
              state: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              assistantMessageId: null,
            },
          },
        ],
      }),
    ).toEqual([activeThreadId]);
  });

  it("signs the activity publish JWT and rejects tampering", async () => {
    const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const payload = {
      iss: "t3-env:env",
      aud: "https://relay.example.test",
      sub: "env",
      jti: "nonce-1",
      iat: 100,
      exp: 200,
      environmentId: state.environmentId,
      threadId: state.threadId,
      state,
    } satisfies RelayAgentActivityPublishProofPayload;
    const proof = await Effect.runPromise(
      AgentAwarenessRelay.signRelayAgentActivityPublishProof({
        privateKey: keyPair.privateKey,
        payload,
      }),
    );

    await expect(
      Effect.runPromise(
        verifyRelayJwt({
          publicKey: keyPair.publicKey,
          token: proof,
          typ: RELAY_ACTIVITY_PUBLISH_TYP,
          issuer: "t3-env:env",
          audience: "https://relay.example.test",
          nowEpochSeconds: 150,
        }),
      ),
    ).resolves.toMatchObject({ jti: "nonce-1", state });
    await expect(
      Effect.runPromise(
        verifyRelayJwt({
          publicKey: keyPair.publicKey,
          token: (() => {
            const [header, body, signature = ""] = proof.split(".");
            const corruptedSignature = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
            return `${header}.${body}.${corruptedSignature}`;
          })(),
          typ: RELAY_ACTIVITY_PUBLISH_TYP,
          issuer: "t3-env:env",
          audience: "https://relay.example.test",
          nowEpochSeconds: 150,
        }),
      ),
    ).rejects.toBeDefined();
  });

  it.effect("does not inspect or publish thread activity while a desktop client is focused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const originalFetch = globalThis.fetch;
        let fetchCount = 0;
        let snapshotReadCount = 0;
        const secrets = makeMemorySecretStore();
        const environmentId = "env-1" as EnvironmentId;
        const threadId = "thread-1" as ThreadId;
        const descriptor = {
          environmentId,
          label: "Test Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        } satisfies ExecutionEnvironmentDescriptor;

        globalThis.fetch = (() => {
          fetchCount += 1;
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        );
        yield* secrets.setString(RELAY_URL_SECRET, "https://transport.example.test");
        yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
        yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");

        const dependencies = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed(descriptor),
          }),
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          } satisfies OrchestrationEngineShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadShellById: () =>
              Effect.sync(() => {
                snapshotReadCount += 1;
                return Option.none();
              }),
          } as unknown as ProjectionSnapshotQueryShape),
          Layer.succeed(
            FocusedDesktopClients.FocusedDesktopClients,
            FocusedDesktopClients.FocusedDesktopClients.of({
              anyFocused: Effect.succeed(true),
              changes: Stream.empty,
              acquire: Effect.void,
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* relay.publishThread(threadId);
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(dependencies),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );

        expect(snapshotReadCount).toBe(0);
        expect(fetchCount).toBe(0);
      }),
    ),
  );

  it.effect("rechecks desktop focus immediately before publishing agent activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const originalFetch = globalThis.fetch;
        let fetchCount = 0;
        let focusReadCount = 0;
        let snapshotReadCount = 0;
        const secrets = makeMemorySecretStore();
        const now = "2026-05-25T00:00:00.000Z";
        const environmentId = "env-1" as EnvironmentId;
        const projectId = "project-1" as ProjectId;
        const threadId = "thread-1" as ThreadId;
        const project = {
          id: projectId,
          title: "T3 Code",
          workspaceRoot: "/workspace",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        } satisfies OrchestrationProjectShell;
        const thread = {
          id: threadId,
          projectId,
          title: "Run remote agent",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-1" as TurnId,
            lastError: null,
            updatedAt: now,
          },
          latestUserMessageAt: now,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } satisfies OrchestrationThreadShell;
        const descriptor = {
          environmentId,
          label: "Test Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        } satisfies ExecutionEnvironmentDescriptor;

        globalThis.fetch = (() => {
          fetchCount += 1;
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        );
        yield* secrets.setString(RELAY_URL_SECRET, "https://transport.example.test");
        yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
        yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");

        const dependencies = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed(descriptor),
          }),
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          } satisfies OrchestrationEngineShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadShellById: () =>
              Effect.sync(() => {
                snapshotReadCount += 1;
                return Option.some(thread);
              }),
            getProjectShellById: () => Effect.succeed(Option.some(project)),
          } as unknown as ProjectionSnapshotQueryShape),
          Layer.succeed(
            FocusedDesktopClients.FocusedDesktopClients,
            FocusedDesktopClients.FocusedDesktopClients.of({
              anyFocused: Effect.sync(() => {
                focusReadCount += 1;
                return focusReadCount > 1;
              }),
              changes: Stream.empty,
              acquire: Effect.void,
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* relay.publishThread(threadId);
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(dependencies),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );

        expect(focusReadCount).toBe(2);
        expect(snapshotReadCount).toBe(1);
        expect(fetchCount).toBe(0);
      }),
    ),
  );

  it.effect("keeps the orchestration listener armed until relay config is installed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        const threadShellRequested = yield* Deferred.make<void>();
        const secrets = makeMemorySecretStore();
        const now = "2026-05-25T00:00:00.000Z";
        const projectId = "project-1" as ProjectId;
        const threadId = "thread-1" as ThreadId;
        const environmentId = "env-1" as EnvironmentId;

        const project = {
          id: projectId,
          title: "T3 Code",
          workspaceRoot: "/workspace",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        } satisfies OrchestrationProjectShell;

        const thread = {
          id: threadId,
          projectId,
          title: "Run remote agent",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-1" as TurnId,
            lastError: null,
            updatedAt: now,
          },
          latestUserMessageAt: now,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } satisfies OrchestrationThreadShell;

        const orchestrationEngine = {
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.fromQueue(events),
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngineShape;

        const snapshotQuery = {
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [thread],
              updatedAt: now,
            } satisfies OrchestrationShellSnapshot),
          getThreadShellById: () =>
            Deferred.succeed(threadShellRequested, undefined).pipe(
              Effect.ignore,
              Effect.as(Option.some(thread)),
            ),
          getProjectShellById: () => Effect.succeed(Option.some(project)),
        } as unknown as ProjectionSnapshotQueryShape;

        const descriptor = {
          environmentId,
          label: "Test Desktop",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "0.0.0-test",
          capabilities: {
            repositoryIdentity: true,
          },
        } satisfies ExecutionEnvironmentDescriptor;

        const layer = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed(descriptor),
          }),
          Layer.succeed(OrchestrationEngineService, orchestrationEngine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* relay.start();
          yield* secrets.setString(RELAY_URL_SECRET, "http://127.0.0.1:1");
          yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
          yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");
          yield* Queue.offer(events, {
            type: "thread.activity-appended",
            sequence: 1,
            eventId: "evt-1",
            commandId: CommandId.make("cmd-1"),
            aggregateKind: "thread",
            aggregateId: threadId,
            actor: { kind: "server" },
            payload: {
              threadId,
              activity: {
                kind: "approval.requested",
              },
            },
            occurredAt: now,
          } as unknown as OrchestrationEvent);

          yield* Deferred.await(threadShellRequested).pipe(Effect.timeout("2 seconds"));
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(layer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      }),
    ),
  );

  it.effect("publishes to the relay transport and clears activity when desktop focus arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const originalFetch = globalThis.fetch;
        const context = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(context);
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        const missingRelayCredentialRead = yield* Deferred.make<void>();
        const fetches = yield* Queue.unbounded<{
          readonly url: URL;
          readonly state: RelayAgentActivityState | null;
        }>();
        const userSpans: Array<string> = [];
        const productSpans: Array<string> = [];
        const collectingTracer = (spans: Array<string>) =>
          Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (endTime, exit) => {
                end(endTime, exit);
                spans.push(span.name);
              };
              return span;
            },
          });
        const secrets = makeMemorySecretStore();
        const now = "2026-05-25T00:00:00.000Z";
        const projectId = "project-1" as ProjectId;
        const threadId = "thread-1" as ThreadId;
        const environmentId = "env-1" as EnvironmentId;

        const project = {
          id: projectId,
          title: "T3 Code",
          workspaceRoot: "/workspace",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        } satisfies OrchestrationProjectShell;

        const thread = {
          id: threadId,
          projectId,
          title: "Run remote agent",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-1" as TurnId,
            lastError: null,
            updatedAt: now,
          },
          latestUserMessageAt: now,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } satisfies OrchestrationThreadShell;

        const descriptor = {
          environmentId,
          label: "Test Desktop",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "0.0.0-test",
          capabilities: {
            repositoryIdentity: true,
          },
        } satisfies ExecutionEnvironmentDescriptor;
        let snapshotThreads: Array<OrchestrationThreadShell> = [thread];
        const focusedDesktopClients = yield* FocusedDesktopClients.make;
        const observedSecretStore = ServerSecretStore.ServerSecretStore.of({
          ...secrets.store,
          get: (name) =>
            secrets.store
              .get(name)
              .pipe(
                Effect.tap((value) =>
                  name === RELAY_ENVIRONMENT_CREDENTIAL_SECRET && Option.isNone(value)
                    ? Deferred.succeed(missingRelayCredentialRead, undefined)
                    : Effect.void,
                ),
              ),
        });

        let tombstoneAttempts = 0;
        globalThis.fetch = (async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : (input as unknown as { readonly url: string }).url,
          );
          const request =
            input instanceof Request
              ? input
              : new Request(typeof input === "string" ? input : input.toString(), init);
          const payload = (await request.json()) as {
            readonly state: RelayAgentActivityState | null;
          };
          if (payload.state === null) {
            tombstoneAttempts += 1;
            if (tombstoneAttempts === 1) {
              throw new Error("transient tombstone publish failure");
            }
          }
          runFork(Queue.offer(fetches, { url, state: payload.state }));
          return Response.json({ ok: true, deliveries: [] });
        }) as typeof fetch;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        );

        const layer = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, observedSecretStore),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed(descriptor),
          }),
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.fromQueue(events),
            latestSequence: Effect.succeed(0),
          } satisfies OrchestrationEngineShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                projects: [project],
                threads: snapshotThreads,
                updatedAt: now,
              } satisfies OrchestrationShellSnapshot),
            getThreadShellById: () => Effect.succeed(Option.some(thread)),
            getProjectShellById: () => Effect.succeed(Option.some(project)),
          } as unknown as ProjectionSnapshotQueryShape),
          Layer.succeed(FocusedDesktopClients.FocusedDesktopClients, focusedDesktopClients),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* secrets.setString(RELAY_URL_SECRET, "https://transport.example.test");
          yield* secrets.setString(RELAY_ISSUER_SECRET, "https://issuer.example.test");
          yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
          yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");
          yield* relay.start();
          yield* Queue.offer(events, {
            type: "thread.activity-appended",
            sequence: 1,
            eventId: "evt-1",
            commandId: CommandId.make("cmd-1"),
            aggregateKind: "thread",
            aggregateId: threadId,
            actor: { kind: "server" },
            payload: {
              threadId,
              activity: {
                kind: "approval.requested",
              },
            },
            occurredAt: now,
          } as unknown as OrchestrationEvent);

          const firstPublish = yield* Queue.take(fetches).pipe(Effect.timeout("2 seconds"));
          expect(firstPublish.url.origin).toBe("https://transport.example.test");
          expect(firstPublish.state?.phase).toBe("running");
          expect(productSpans).toContain("makePublishProof");
          expect(userSpans).not.toContain("makePublishProof");

          yield* TestClock.adjust("1 second");
          yield* secrets.store.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
          const desktopFocusScope = yield* Scope.make();
          yield* focusedDesktopClients.acquire.pipe(Scope.provide(desktopFocusScope));
          yield* Deferred.await(missingRelayCredentialRead).pipe(Effect.timeout("2 seconds"));
          yield* secrets.setString(
            RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
            "relay-credential-restored",
          );
          for (let iteration = 0; iteration < 10; iteration++) {
            if (tombstoneAttempts >= 2) {
              break;
            }
            yield* TestClock.adjust("1 second");
            yield* Effect.yieldNow;
          }
          const focusedPublish = yield* Queue.take(fetches).pipe(Effect.timeout("2 seconds"));
          expect(focusedPublish.url.origin).toBe("https://transport.example.test");
          expect(focusedPublish.state).toBeNull();
          expect(tombstoneAttempts).toBe(2);

          snapshotThreads = [];
          yield* Scope.close(desktopFocusScope, Exit.void);
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(layer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.provideService(RelayClientTracer, Option.some(collectingTracer(productSpans))),
          Effect.withTracer(collectingTracer(userSpans)),
        );
      }),
    ),
  );
});
