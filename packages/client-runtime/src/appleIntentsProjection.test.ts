import {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  buildAppleIntentsSnapshot,
  diffAppleIntentsSnapshots,
  sanitizeAppleIntentPreview,
} from "./appleIntentsProjection.ts";

const envId = EnvironmentId.make("env-mac");
const projectId = ProjectId.make("proj-1");
const decodeProjectShell = Schema.decodeSync(OrchestrationProjectShell);
const decodeThreadShell = Schema.decodeSync(OrchestrationV2ThreadShell);

function makeProject(overrides?: Partial<Record<string, unknown>>): OrchestrationProjectShell {
  return decodeProjectShell({
    id: projectId,
    title: "t3code",
    workspaceRoot: "/Users/dev/t3code",
    repositoryIdentity: {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/pingdotgg/t3code.git",
      },
      displayName: "pingdotgg/t3code",
      provider: "github",
      owner: "pingdotgg",
      name: "t3code",
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  });
}

function makeThread(
  id: string,
  overrides?: Partial<Record<string, unknown>>,
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  const now = DateTime.makeUnsafe("2026-09-10T12:00:00.000Z");
  return decodeThreadShell({
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: `Thread ${id}`,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: {
      id: "msg-1",
      role: "assistant",
      text: "Fixed the auth test.\n```ts\nconst token = 'sk-1234567890abcdef123456';\n```",
      updatedAt: now,
    },
    latestUserMessageAt: now,
    hasActionableProposedPlan: false,
    itemCount: 2,
    visibleItemCount: 2,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  });
}

describe("appleIntentsProjection", () => {
  it("sanitizes ANSI codes, code fences, and secret tokens in message previews", () => {
    const preview = sanitizeAppleIntentPreview(
      "\u001b[32mDone\u001b[0m using Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig and sk-proj1234567890abcdef123456\n```ts\nsecret()\n```",
    );
    expect(preview).toBe("Done using Bearer [redacted] and [redacted] [code]");
    expect(sanitizeAppleIntentPreview("   \n\t  ")).toBeNull();
    expect(sanitizeAppleIntentPreview("a".repeat(250), 20)).toBe(`${"a".repeat(19)}…`);
  });

  it("filters deleted, archived, and quiet subagents while prioritizing attention and active threads", () => {
    const project = makeProject();
    const now = DateTime.makeUnsafe("2026-09-10T12:00:00.000Z");
    const older = DateTime.makeUnsafe("2026-09-09T12:00:00.000Z");
    const threads = [
      makeThread("archived", { archivedAt: now }),
      makeThread("deleted", { deletedAt: now }),
      makeThread("quiet-subagent", {
        lineage: {
          parentThreadId: ThreadId.make("running"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("running"),
        },
        status: "running",
      }),
      makeThread("approval-subagent", {
        lineage: {
          parentThreadId: ThreadId.make("running"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("running"),
        },
        status: "waiting",
        pendingRuntimeRequest: {
          id: "req-1",
          kind: "command",
          createdAt: now,
        },
      }),
      makeThread("settled", { settledOverride: "settled", settledAt: now, updatedAt: now }),
      makeThread("running", { status: "running", updatedAt: older }),
      makeThread("pinned", { pinnedAt: now, updatedAt: older }),
    ];

    const snapshot = buildAppleIntentsSnapshot(
      [
        {
          environmentId: envId,
          label: "MacBook Pro",
          httpBaseUrl: "http://127.0.0.1:3773",
          isLocal: true,
          isConnected: true,
          projects: [project],
          threads,
        },
      ],
      { indexMessagePreviews: false, nowMs: DateTime.toEpochMillis(now), maxThreads: 3 },
    );

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]).toMatchObject({
      id: `${envId}:${projectId}`,
      name: "t3code",
      repositoryIdentity: "github.com/pingdotgg/t3code",
    });
    // Capped to 3 and ordered: pending approval subagent > running > pinned (settled dropped by cap).
    expect(snapshot.threads.map((t) => t.threadId)).toEqual([
      "approval-subagent",
      "running",
      "pinned",
    ]);
    expect(snapshot.threads[0]?.hasPendingRequest).toBe(true);
    expect(snapshot.threads[0]?.pendingRequestSummary).toBe("Command approval required");
    expect(snapshot.threads[0]?.lastMessagePreview).toBeNull();
    expect(snapshot.threads[1]?.deepLinkUrl).toBe(`t3code://threads/${envId}/running`);
  });

  it("includes sanitized previews only when opt-in is enabled and computes minimal deltas", () => {
    const project = makeProject();
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const nowMs = Date.parse("2026-09-10T12:00:00.000Z");

    const first = buildAppleIntentsSnapshot(
      [
        {
          environmentId: envId,
          label: "MacBook Pro",
          httpBaseUrl: "http://127.0.0.1:3773",
          isLocal: true,
          isConnected: true,
          projects: [project],
          threads: [t1, t2],
        },
      ],
      { indexMessagePreviews: true, nowMs },
    );
    expect(first.threads[0]?.lastMessagePreview).toBe("Fixed the auth test. [code]");

    const initialDiff = diffAppleIntentsSnapshots(null, first);
    expect(initialDiff.hasChanges).toBe(true);
    expect(initialDiff.delta.upsertedThreads).toHaveLength(2);

    const noopDiff = diffAppleIntentsSnapshots(first, first);
    expect(noopDiff.hasChanges).toBe(false);

    const second = buildAppleIntentsSnapshot(
      [
        {
          environmentId: envId,
          label: "MacBook Pro",
          httpBaseUrl: "http://127.0.0.1:3773",
          isLocal: true,
          isConnected: true,
          projects: [project],
          threads: [makeThread("t1", { title: "Renamed" })],
        },
      ],
      { indexMessagePreviews: true, nowMs },
    );
    const updateDiff = diffAppleIntentsSnapshots(first, second);
    expect(updateDiff.hasChanges).toBe(true);
    expect(updateDiff.delta.upsertedThreads.map((t) => t.threadId)).toEqual(["t1"]);
    expect(updateDiff.delta.removedThreadIds).toEqual([`${envId}:t2`]);
    expect(updateDiff.delta.upsertedProjects).toEqual([]);
  });
});
