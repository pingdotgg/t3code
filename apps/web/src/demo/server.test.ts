import { ClientOrchestrationCommand, type GitRunStackedActionInput } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { demoEnvironments, DEMO_METRICS_WORKTREE_PATH, demoVcsStatusByCwd } from "./fixtures";
import {
  applyDemoGitActionToStatus,
  demoGitActionEvents,
  DemoSettingsStore,
  DemoShellStore,
  dispatchDemoCommand,
} from "./server";

const decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

describe("demo shell mutations", () => {
  it("timestamps mode changes when they are applied", () => {
    const environment = demoEnvironments.find(
      (candidate) => candidate.environmentId === "demo-mac-studio",
    );
    if (!environment) throw new Error("Missing Mac Studio demo environment");

    const store = new DemoShellStore(environment.shellSnapshot);
    const appliedAfter = Date.now();
    store.dispatch(
      decodeCommand({
        type: "thread.runtime-mode.set",
        commandId: "command-runtime-mode",
        threadId: "thread-composer",
        runtimeMode: "approval-required",
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    store.dispatch(
      decodeCommand({
        type: "thread.interaction-mode.set",
        commandId: "command-interaction-mode",
        threadId: "thread-composer",
        interactionMode: "plan",
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
    );

    const thread = store.thread("thread-composer");
    expect(thread?.runtimeMode).toBe("approval-required");
    expect(thread?.interactionMode).toBe("plan");
    expect(Date.parse(thread?.updatedAt ?? "")).toBeGreaterThanOrEqual(appliedAfter);
  });

  it("preserves a newer branch when metadata reconciliation is stale", () => {
    const environment = demoEnvironments.find(
      (candidate) => candidate.environmentId === "demo-mac-studio",
    );
    if (!environment) throw new Error("Missing Mac Studio demo environment");

    const store = new DemoShellStore(environment.shellSnapshot);
    const original = store.thread("thread-composer");
    if (!original) throw new Error("Missing composer demo thread");

    store.dispatch(
      decodeCommand({
        type: "thread.meta.update",
        commandId: "command-stale-branch",
        threadId: original.id,
        title: "Updated title",
        branch: "feature/stale-ref",
        expectedBranch: "feature/previous-ref",
      }),
    );

    expect(store.thread(original.id)).toMatchObject({
      title: "Updated title",
      branch: original.branch,
    });
  });

  it("moves archived threads out of the active shell stream and restores them on unarchive", () => {
    const environment = demoEnvironments.find(
      (candidate) => candidate.environmentId === "demo-mac-studio",
    );
    if (!environment) throw new Error("Missing Mac Studio demo environment");

    const store = new DemoShellStore(environment.shellSnapshot);
    const events: Array<{ kind: string }> = [];
    store.subscribe((event) => events.push(event));

    store.dispatch(
      decodeCommand({
        type: "thread.archive",
        commandId: "command-archive",
        threadId: "thread-composer",
      }),
    );

    expect(store.snapshot().threads.some((thread) => thread.id === "thread-composer")).toBe(false);
    expect(
      store.archivedSnapshot().threads.find((thread) => thread.id === "thread-composer")
        ?.archivedAt,
    ).not.toBeNull();
    expect(events.at(-1)?.kind).toBe("thread-removed");

    store.dispatch(
      decodeCommand({
        type: "thread.unarchive",
        commandId: "command-unarchive",
        threadId: "thread-composer",
      }),
    );

    expect(
      store.snapshot().threads.find((thread) => thread.id === "thread-composer")?.archivedAt,
    ).toBe(null);
    expect(store.archivedSnapshot().threads.some((thread) => thread.id === "thread-composer")).toBe(
      false,
    );
    expect(events.at(-1)?.kind).toBe("thread-upserted");
  });

  it.effect("requires force to delete a project with threads", () =>
    Effect.gen(function* () {
      const environment = demoEnvironments.find(
        (candidate) => candidate.environmentId === "demo-mac-studio",
      );
      if (!environment) throw new Error("Missing Mac Studio demo environment");

      const store = new DemoShellStore(environment.shellSnapshot);
      const thread = store.thread("thread-composer");
      if (!thread) throw new Error("Missing composer demo thread");
      const sequence = store.snapshot().snapshotSequence;

      const blockedDelete = yield* Effect.flip(
        dispatchDemoCommand(
          store,
          decodeCommand({
            type: "project.delete",
            commandId: "command-project-delete",
            projectId: thread.projectId,
          }),
        ),
      );
      expect(blockedDelete).toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
        message: `Project '${thread.projectId}' is not empty and cannot be deleted without force=true.`,
      });
      expect(store.snapshot().snapshotSequence).toBe(sequence);
      expect(store.snapshot().projects.some((project) => project.id === thread.projectId)).toBe(
        true,
      );
      expect(store.thread(thread.id)).toBeDefined();

      store.dispatch(
        decodeCommand({
          type: "project.delete",
          commandId: "command-project-force-delete",
          projectId: thread.projectId,
          force: true,
        }),
      );
      expect(store.snapshot().projects.some((project) => project.id === thread.projectId)).toBe(
        false,
      );
      expect(store.thread(thread.id)).toBeUndefined();
    }),
  );

  it.effect("does not expose unexpected dispatch defect messages", () =>
    Effect.gen(function* () {
      const environment = demoEnvironments.find(
        (candidate) => candidate.environmentId === "demo-mac-studio",
      );
      if (!environment) throw new Error("Missing Mac Studio demo environment");

      const store = new DemoShellStore(environment.shellSnapshot);
      store.dispatch = () => {
        throw new Error("internal implementation detail");
      };

      const error = yield* Effect.flip(
        dispatchDemoCommand(
          store,
          decodeCommand({
            type: "project.delete",
            commandId: "command-project-delete-defect",
            projectId: "project-missing",
          }),
        ),
      );

      expect(error).toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
        message: "Failed to dispatch demo orchestration command.",
      });
    }),
  );
});

describe("demo settings", () => {
  it("persists settings patches", () => {
    const environment = demoEnvironments.find(
      (candidate) => candidate.environmentId === "demo-mac-studio",
    );
    if (!environment) throw new Error("Missing Mac Studio demo environment");

    const store = new DemoSettingsStore(environment.serverConfig.settings);
    const next = store.update({ enableAssistantStreaming: true });

    expect(next.enableAssistantStreaming).toBe(true);
    expect(store.snapshot().enableAssistantStreaming).toBe(true);
  });
});

describe("demo git actions", () => {
  it("reports and applies a requested feature branch", () => {
    const input = {
      actionId: "demo-feature-branch",
      cwd: DEMO_METRICS_WORKTREE_PATH,
      action: "commit_push_pr",
      commitMessage: "Add release filters",
      featureBranch: true,
    } satisfies GitRunStackedActionInput;
    const current = demoVcsStatusByCwd[DEMO_METRICS_WORKTREE_PATH];
    if (current?._tag !== "snapshot") throw new Error("Missing metrics VCS snapshot");

    const events = demoGitActionEvents(input);
    const started = events.find((event) => event.kind === "action_started");
    const finished = events.find((event) => event.kind === "action_finished");

    expect(started?.phases).toEqual(["branch", "commit", "push", "pr"]);
    expect(finished?.result.branch).toEqual({
      status: "created",
      name: "feat/add-release-filters",
    });
    expect(finished?.result.push).toMatchObject({
      status: "pushed",
      branch: "feat/add-release-filters",
    });

    const next = applyDemoGitActionToStatus(current, input);
    expect(next.local).toMatchObject({
      isDefaultRef: false,
      refName: "feat/add-release-filters",
      hasWorkingTreeChanges: false,
    });
    expect(next.remote).toMatchObject({
      hasUpstream: true,
      aheadCount: 0,
      pr: { headRef: "feat/add-release-filters" },
    });
  });

  it("keeps a feature-branch commit ahead until it is pushed", () => {
    const input = {
      actionId: "demo-feature-branch-commit",
      cwd: "~/code/t3code",
      action: "commit",
      commitMessage: "Add release filters",
      featureBranch: true,
    } satisfies GitRunStackedActionInput;
    const current = demoVcsStatusByCwd[input.cwd];
    if (current?._tag !== "snapshot") throw new Error("Missing default checkout VCS snapshot");

    const next = applyDemoGitActionToStatus(current, input);

    expect(next.local).toMatchObject({
      isDefaultRef: false,
      refName: "feat/add-release-filters",
      hasWorkingTreeChanges: false,
    });
    expect(next.remote).toMatchObject({
      hasUpstream: false,
      aheadCount: 1,
      aheadOfDefaultCount: 1,
    });
  });

  it("does not report the default branch as ahead of itself", () => {
    const input = {
      actionId: "demo-default-branch-commit",
      cwd: "~/code/t3code",
      action: "commit",
      commitMessage: "Update release filters",
      featureBranch: false,
    } satisfies GitRunStackedActionInput;
    const current = demoVcsStatusByCwd[input.cwd];
    if (current?._tag !== "snapshot") throw new Error("Missing default checkout VCS snapshot");

    const next = applyDemoGitActionToStatus(current, input);

    expect(next.local).toMatchObject({
      isDefaultRef: true,
      refName: "main",
    });
    expect(next.remote).toMatchObject({
      aheadCount: 1,
      aheadOfDefaultCount: 0,
    });
  });
});
