import type {
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  ThreadOwner,
  TurnId,
} from "@t3tools/contracts";
import {
  AuthOrchestrationReadScope,
  PLUGINS_WS_METHODS,
  ProviderInstanceId,
  WS_METHODS,
  pluginReadScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { isMethodAuthorized, toThreadUpsertedShellStreamEvent } from "./ws.ts";

const now = "2026-05-25T00:00:00.000Z";
const threadId = "thread-1" as ThreadId;
const projectId = "project-1" as ProjectId;

const threadShell = {
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
  session: null,
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} satisfies OrchestrationThreadShell;

const makeSnapshotQuery = (owner: Option.Option<ThreadOwner>) => {
  let shellLookups = 0;
  const stub = {
    getThreadOwnerById: () => Effect.succeed(owner),
    getThreadShellById: () => {
      shellLookups += 1;
      return Effect.succeed(Option.some(threadShell));
    },
  } as unknown as ProjectionSnapshotQueryShape;
  return { stub, shellLookups: () => shellLookups };
};

describe("toThreadUpsertedShellStreamEvent", () => {
  it.effect("drops the event for a plugin-owned thread and skips the shell lookup", () =>
    Effect.gen(function* () {
      const { stub, shellLookups } = makeSnapshotQuery(Option.some("plugin:test" as ThreadOwner));

      const result = yield* toThreadUpsertedShellStreamEvent(stub, threadId, 7);

      expect(Option.isNone(result)).toBe(true);
      // The plugin thread must never be materialized into a shell payload that
      // could leak to connected clients.
      expect(shellLookups()).toBe(0);
    }),
  );

  it.effect("emits a thread-upserted event for a user-owned thread", () =>
    Effect.gen(function* () {
      const { stub } = makeSnapshotQuery(Option.some("user"));

      const result = yield* toThreadUpsertedShellStreamEvent(stub, threadId, 7);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.kind).toBe("thread-upserted");
        expect(result.value.sequence).toBe(7);
        if (result.value.kind === "thread-upserted") {
          expect(result.value.thread.id).toBe(threadId);
        }
      }
    }),
  );

  it.effect("emits for a missing owner row (deleted/unknown thread proceeds)", () =>
    Effect.gen(function* () {
      const { stub } = makeSnapshotQuery(Option.none());

      const result = yield* toThreadUpsertedShellStreamEvent(stub, threadId, 7);

      expect(Option.isSome(result)).toBe(true);
    }),
  );
});

describe("isMethodAuthorized", () => {
  const pluginRead = pluginReadScope("acme");

  it("lets a least-privilege plugin-scoped token satisfy the plugin call/subscribe baseline", () => {
    // A token holding only `plugin:acme:read` does NOT satisfy the orchestration
    // read baseline, but must still reach the dispatcher for plugin invocation.
    expect(
      isMethodAuthorized(PLUGINS_WS_METHODS.call, AuthOrchestrationReadScope, [pluginRead]),
    ).toBe(true);
    expect(
      isMethodAuthorized(PLUGINS_WS_METHODS.subscribe, AuthOrchestrationReadScope, [pluginRead]),
    ).toBe(true);
  });

  it("does not let a plugin scope satisfy any non-plugin method (no broadening)", () => {
    expect(
      isMethodAuthorized(WS_METHODS.filesystemBrowse, AuthOrchestrationReadScope, [pluginRead]),
    ).toBe(false);
    expect(
      isMethodAuthorized(PLUGINS_WS_METHODS.list, AuthOrchestrationReadScope, [pluginRead]),
    ).toBe(false);
  });

  it("keeps the orchestration-read baseline for plugin call and rejects an unscoped session", () => {
    expect(
      isMethodAuthorized(PLUGINS_WS_METHODS.call, AuthOrchestrationReadScope, [
        AuthOrchestrationReadScope,
      ]),
    ).toBe(true);
    expect(isMethodAuthorized(PLUGINS_WS_METHODS.call, AuthOrchestrationReadScope, [])).toBe(false);
  });
});
