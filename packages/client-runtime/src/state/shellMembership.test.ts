import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { EnvironmentShellMembership, environmentShellMembershipLayer } from "./shellMembership.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      archivedAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      session: null,
    },
  ],
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("EnvironmentShellMembership", () => {
  it.effect("resets authoritative membership to unknown", () =>
    Effect.gen(function* () {
      const membership = yield* EnvironmentShellMembership;

      expect(yield* membership.getThreadMembership(ENVIRONMENT_ID, THREAD_ID)).toBe("unknown");
      const firstRevision = yield* membership.setUnknown(ENVIRONMENT_ID);
      yield* membership.setAuthoritative(ENVIRONMENT_ID, SNAPSHOT, firstRevision);
      expect(yield* membership.getThreadMembership(ENVIRONMENT_ID, THREAD_ID)).toBe("present");
      expect(
        yield* membership.getThreadMembership(ENVIRONMENT_ID, ThreadId.make("missing-thread")),
      ).toBe("absent");

      const currentRevision = yield* membership.setUnknown(ENVIRONMENT_ID);
      expect(yield* membership.getThreadMembership(ENVIRONMENT_ID, THREAD_ID)).toBe("unknown");

      // Simulate a snapshot write that was paused before a disconnect invalidated
      // its subscription revision. Resuming it cannot restore stale authority.
      yield* membership.setAuthoritative(ENVIRONMENT_ID, SNAPSHOT, firstRevision);
      expect(yield* membership.getThreadMembership(ENVIRONMENT_ID, THREAD_ID)).toBe("unknown");

      yield* membership.setAuthoritative(ENVIRONMENT_ID, SNAPSHOT, currentRevision);
      expect(yield* membership.getThreadMembership(ENVIRONMENT_ID, THREAD_ID)).toBe("present");
    }).pipe(Effect.provide(environmentShellMembershipLayer)),
  );
});
