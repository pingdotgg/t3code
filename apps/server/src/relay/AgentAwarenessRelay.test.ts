import { generateKeyPairSync } from "node:crypto";
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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
      })) satisfies ServerSecretStore.ServerSecretStoreShape["get"],
    set: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStoreShape["set"],
    create: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStoreShape["create"],
    getOrCreateRandom: ((name, bytes) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) {
          return existing;
        }
        const generated = new Uint8Array(bytes);
        values.set(name, generated);
        return generated;
      })) satisfies ServerSecretStore.ServerSecretStoreShape["getOrCreateRandom"],
    remove: ((name) =>
      Effect.sync(() => {
        values.delete(name);
      })) satisfies ServerSecretStore.ServerSecretStoreShape["remove"],
  } satisfies ServerSecretStore.ServerSecretStoreShape;
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

  it("does not publish streaming content or non-awareness activity events", () => {
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
    ).toBe(true);
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
    const keyPair = generateKeyPairSync("ed25519", {
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

  it.effect("publishes agent activity to the relay transport URL, not the relay issuer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const originalFetch = globalThis.fetch;
        const context = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(context);
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        const fetchSeen = yield* Deferred.make<URL>();
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

        globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : (input as unknown as { readonly url: string }).url,
          );
          runFork(Deferred.succeed(fetchSeen, url));
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        );

        const layer = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed(descriptor),
          }),
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.fromQueue(events),
          } satisfies OrchestrationEngineShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                projects: [project],
                threads: [thread],
                updatedAt: now,
              } satisfies OrchestrationShellSnapshot),
            getThreadShellById: () => Effect.succeed(Option.some(thread)),
            getProjectShellById: () => Effect.succeed(Option.some(project)),
          } as unknown as ProjectionSnapshotQueryShape),
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

          const url = yield* Deferred.await(fetchSeen).pipe(Effect.timeout("2 seconds"));
          expect(url.origin).toBe("https://transport.example.test");
          expect(productSpans).toContain("makePublishProof");
          expect(userSpans).not.toContain("makePublishProof");
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
