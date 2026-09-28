import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type ResumableAgentSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createAgentSessionResumeAtoms,
  filterResumableSessions,
  resumableSessionLocation,
} from "./agentSessions.ts";

const session = (overrides: Partial<ResumableAgentSession>): ResumableAgentSession => ({
  provider: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  sessionId: "019a0d94-6480-7831-b253-569ae0ea6be1",
  title: "Fix the flaky test",
  cwd: "/repo/app",
  branch: null,
  updatedAt: "2026-09-26T12:00:00.000Z",
  ...overrides,
});

describe("createAgentSessionResumeAtoms", () => {
  it.effect("hides an imported session when the picker reopens before its cache expires", () =>
    Effect.gen(function* () {
      const external = session({});
      let sessions = [external];
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("resume-test"),
        label: "Test environment",
        httpBaseUrl: "https://example.test",
        wsBaseUrl: "wss://example.test",
      });
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.agentSessionsList]: () =>
                Effect.sync(() => ({ sessions, truncated: false })),
              [WS_METHODS.agentSessionsAttach]: () =>
                Effect.sync(() => {
                  sessions = [];
                  return { threadId: ThreadId.make("imported-thread") };
                }),
            },
          } as unknown as RpcSession),
        ),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.mock(EnvironmentRegistry)({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map(),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          run: (_environmentId, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: (_environmentId, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        }),
      );
      const { list, attach } = createAgentSessionResumeAtoms(runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const project = {
        environmentId: target.environmentId,
        input: { projectId: ProjectId.make("project") },
      };
      const query = list(project);
      const close = registry.mount(query);
      expect(yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).toEqual({
        sessions: [external],
        truncated: false,
      });

      const result = yield* Effect.promise(() =>
        attach.run(registry, {
          ...project,
          input: {
            ...project.input,
            providerInstanceId: external.providerInstanceId,
            sessionId: external.sessionId,
          },
        }),
      );
      expect(AsyncResult.isSuccess(result)).toBe(true);
      close();
      registry.mount(query);
      expect(yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).toEqual({
        sessions: [],
        truncated: false,
      });
    }),
  );
});

describe("filterResumableSessions", () => {
  const codex = session({});
  const claude = session({
    provider: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    sessionId: "8c119ee3-f063-4999-87ce-a062d004c37c",
    title: "Refactor the importer",
    branch: "feature/resume",
  });

  it("matches a pasted resume command by its session ID", () => {
    expect(filterResumableSessions([codex, claude], `codex resume ${codex.sessionId}`)).toEqual([
      codex,
    ]);
    expect(
      filterResumableSessions([codex, claude], `  claude --resume ${claude.sessionId}`),
    ).toEqual([claude]);
  });

  it("matches title and branch case-insensitively and keeps everything for an empty search", () => {
    expect(filterResumableSessions([codex, claude], "FLAKY")).toEqual([codex]);
    expect(filterResumableSessions([codex, claude], "feature/")).toEqual([claude]);
    expect(filterResumableSessions([codex, claude], "  ")).toEqual([codex, claude]);
  });
});

describe("resumableSessionLocation", () => {
  it("prefers the branch and falls back to the directory name", () => {
    expect(resumableSessionLocation(session({ branch: "main" }))).toBe("main");
    expect(resumableSessionLocation(session({ cwd: "/repo/app/" }))).toBe("app");
  });
});
