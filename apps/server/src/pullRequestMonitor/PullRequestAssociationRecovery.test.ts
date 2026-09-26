import {
  CommandId,
  EventId,
  GitHubCliError,
  GitManagerError,
  MessageId,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitStatusResult,
  type GitStatusLocalResult,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type PendingPullRequestAssociation,
} from "@t3tools/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { GitManager } from "../git/Services/GitManager.ts";
import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  makePullRequestAssociationRecovery,
  reportedPullRequestUrl,
} from "./PullRequestAssociationRecovery.ts";
import { createdPullRequestLinks } from "./CreatedPullRequestReviewReactor.ts";

const now = "2026-09-08T00:00:00.000Z";
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const threadId = ThreadId.make("thread");
const url = "https://github.com/acme/app/pull/42";
const message = (text = `Draft PR: [#42](${url})`): OrchestrationMessage => ({
  id: MessageId.make("message"),
  role: "assistant",
  text,
  streaming: false,
  turnId: null,
  createdAt: now,
  updatedAt: now,
});
const status: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: {
    number: 42,
    title: "Feature",
    url,
    baseBranch: "main",
    headBranch: "feature",
    state: "open",
  },
};
const localStatus: GitStatusLocalResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature",
  hasWorkingTreeChanges: false,
  workingTree: status.workingTree,
};
const pendingIntent = (nextAttemptAt = now): PendingPullRequestAssociation => ({
  requestId: CommandId.make("association-request"),
  reference: url,
  requestedAt: now,
  nextAttemptAt,
  status: "pending",
});

async function harness() {
  const commandId = CommandId.make("create");
  let model = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.make("created"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      payload: {
        threadId,
        projectId: ProjectId.make("project"),
        title: "Feature",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: "/isolated/worktree",
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  model = {
    ...model,
    threads: model.threads.map((thread) => ({ ...thread, messages: [message()] })),
    projects: [
      {
        id: ProjectId.make("project"),
        title: "Feature",
        workspaceRoot: "/repo",
        repositoryIdentity: {
          canonicalKey: "github.com/acme/app",
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "https://github.com/acme/app.git",
          },
        },
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
  };
  const commands: OrchestrationCommand[] = [];
  let lookups = 0;
  let invalidations = 0;
  let localInvalidations = 0;
  let resolveLookups = 0;
  let gitStatus = status;
  let gitLocalStatus = localStatus;
  let resolvedPullRequest = status.pr!;
  let failLookup = false;
  let onLookup = () => {};
  let failResolve: GitHubCliError | null = null;
  let onResolve = () => {};
  let currentTime = Date.parse(now);
  const unexpected = () => Effect.die("Unexpected service call");
  const makeRecovery = () =>
    makePullRequestAssociationRecovery(() => currentTime).pipe(
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(model),
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            const planned = yield* decideOrchestrationCommand({ readModel: model, command });
            for (const event of "type" in planned ? [planned] : planned) {
              model = yield* projectEvent(
                model,
                decodeEvent({
                  ...event,
                  sequence: model.snapshotSequence + 1,
                  eventId: EventId.make(crypto.randomUUID()),
                }),
              );
            }
            return { sequence: model.snapshotSequence };
          }),
        withWorktreeLock: (effect) => effect,
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        acquireDomainEventSubscription: Effect.die("Unexpected subscription"),
      }),
      Effect.provideService(GitManager, {
        status: ({ cwd }) =>
          Effect.gen(function* () {
            expect(cwd).toBe("/isolated/worktree");
            expect(invalidations).toBeGreaterThan(lookups);
            lookups++;
            onLookup();
            if (failLookup) {
              return yield* new GitManagerError({
                operation: "status",
                detail: "Temporary failure",
              });
            }
            return gitStatus;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            invalidations++;
          }),
        localStatus: ({ cwd }) =>
          Effect.sync(() => {
            expect(cwd).toBe("/isolated/worktree");
            return gitLocalStatus;
          }),
        remoteStatus: unexpected,
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            localInvalidations++;
          }),
        invalidateRemoteStatus: unexpected,
        resolvePullRequest: ({ cwd, reference }) =>
          Effect.gen(function* () {
            expect(cwd).toBe("/isolated/worktree");
            expect(reference).toBe(url);
            resolveLookups++;
            onResolve();
            if (failResolve) return yield* failResolve;
            return { pullRequest: resolvedPullRequest };
          }),
        preparePullRequestThread: unexpected,
        runStackedAction: unexpected,
      }),
    );
  let recovery = await Effect.runPromise(makeRecovery());
  return {
    get recovery() {
      return recovery;
    },
    commands,
    lookups: () => lookups,
    resolveLookups: () => resolveLookups,
    localInvalidations: () => localInvalidations,
    setFailure: (value: boolean) => {
      failLookup = value;
    },
    setResolveFailure: (error: GitHubCliError | null) => {
      failResolve = error;
    },
    onResolve: (callback: () => void) => {
      onResolve = callback;
    },
    setLocalStatus: (value: GitStatusLocalResult) => {
      gitLocalStatus = value;
    },
    setResolvedPullRequest: (value: typeof resolvedPullRequest) => {
      resolvedPullRequest = value;
    },
    setPendingIntent: (value: PendingPullRequestAssociation) => {
      model = {
        ...model,
        threads: model.threads.map((thread) => ({
          ...thread,
          pendingPullRequestAssociation: value,
        })),
      };
    },
    advanceTo: (value: string) => {
      currentTime = Date.parse(value);
    },
    restart: async () => {
      recovery = await Effect.runPromise(makeRecovery());
    },
    onLookup: (callback: () => void) => {
      onLookup = callback;
    },
    thread: () => model.threads[0],
    setStatus: (value: GitStatusResult) => {
      gitStatus = value;
    },
    updateThread: (update: Partial<(typeof model.threads)[number]>) => {
      model = { ...model, threads: model.threads.map((thread) => ({ ...thread, ...update })) };
    },
  };
}

describe("reportedPullRequestUrl", () => {
  it("reads plain and Markdown URLs, deduplicating repeated links", () => {
    expect(reportedPullRequestUrl({ messages: [message(`${url}\n[PR](${url})`)] })).toBe(url);
    for (const text of [`<${url}>`, `"${url}"`, `\`${url}\``]) {
      expect(reportedPullRequestUrl({ messages: [message(text)] })).toBe(url);
    }
  });

  it("does not infer from user input, partial streams, or ambiguous references", () => {
    for (const messages of [
      [{ ...message(), role: "user" as const }],
      [{ ...message(), streaming: true }],
      [message(`${url} https://github.com/acme/app/pull/43`)],
      [message(), message("No PR was created.")],
      [message("https://github.com@evil.example/acme/app/pull/42")],
      [message(`https://example.test/${url}`)],
      [message(`https://example.test/?redirect=${url}`)],
      [message(`prefix${url}`)],
    ]) {
      expect(reportedPullRequestUrl({ messages })).toBeNull();
    }
  });

  it("selects the latest completed report while a follow-up is streaming", () => {
    expect(
      reportedPullRequestUrl({
        messages: [message(), { ...message("Working on follow-up"), streaming: true }],
      }),
    ).toBe(url);
  });

  it("recognizes Enterprise-host PR paths", () => {
    const enterpriseUrl = "https://github.acme.test/acme/app/pull/42";
    expect(reportedPullRequestUrl({ messages: [message(enterpriseUrl)] })).toBe(enterpriseUrl);
  });
});

describe("pull request association recovery", () => {
  it("recovers persisted assistant output without a separate agent tool call", async () => {
    const h = await harness();
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toEqual([
      expect.objectContaining({
        type: "thread.meta.update",
        threadId,
        expectedUpdatedAt: now,
        expectedWorkspaceCwd: "/isolated/worktree",
        pullRequest: status.pr,
        pullRequestSource: "recovered",
      }),
    ]);
    expect(h.commands[0]).not.toHaveProperty("pullRequestOwnership");
    expect(h.thread()?.pullRequest).toEqual(status.pr);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.lookups()).toBe(1);
  });

  it("marks a verified assistant-created PR eligible for automatic review", async () => {
    const h = await harness();
    h.updateThread({
      messages: [message(`Implemented and opened a new [PR #42](${url}).`)],
    });
    await Effect.runPromise(h.recovery.sweep);

    expect(h.commands[0]).toMatchObject({
      type: "thread.meta.update",
      pullRequestSource: "agent",
    });
    const recoveredThread = h.thread();
    if (!recoveredThread) throw new Error("Expected the PR creator thread.");
    expect(createdPullRequestLinks(recoveredThread)).toMatchObject([
      { source: "agent", pullRequest: { url } },
    ]);
  });

  it("upgrades a verified creation report recovered before this fix", async () => {
    const h = await harness();
    const pullRequest = status.pr;
    if (!pullRequest) throw new Error("Expected a PR in the test fixture.");
    h.updateThread({
      messages: [message(`Created: [acme/app#42](${url}) — ready for review.`)],
      pullRequest,
      pullRequests: [{ pullRequest, source: "recovered", linkedAt: now }],
    });
    await Effect.runPromise(h.recovery.sweep);

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({
      type: "thread.meta.update",
      pullRequestSource: "agent",
      expectedWorkspaceCwd: "/isolated/worktree",
    });
    const recoveredThread = h.thread();
    if (!recoveredThread) throw new Error("Expected the PR creator thread.");
    expect(createdPullRequestLinks(recoveredThread)).toHaveLength(1);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.lookups()).toBe(1);
  });

  it("recovers an older creation report after the chat has continued", async () => {
    const h = await harness();
    const pullRequest = status.pr;
    if (!pullRequest) throw new Error("Expected a PR in the test fixture.");
    h.updateThread({
      messages: [message(`Created: [acme/app#42](${url})`), message("Follow-up complete.")],
      pullRequest,
      pullRequests: [{ pullRequest, source: "recovered", linkedAt: now }],
    });

    await Effect.runPromise(h.recovery.sweep);

    expect(h.commands[0]).toMatchObject({
      type: "thread.meta.update",
      pullRequestSource: "agent",
    });
  });

  it("does not promote generic recovered or explicitly manual associations", async () => {
    const h = await harness();
    const pullRequest = status.pr;
    if (!pullRequest) throw new Error("Expected a PR in the test fixture.");
    h.updateThread({
      messages: [message(`PR: [acme/app#42](${url})`)],
      pullRequest,
      pullRequests: [{ pullRequest, source: "recovered", linkedAt: now }],
    });
    await Effect.runPromise(h.recovery.sweep);
    expect(h.lookups()).toBe(0);
    const recoveredThread = h.thread();
    if (!recoveredThread) throw new Error("Expected the PR creator thread.");
    expect(createdPullRequestLinks(recoveredThread)).toEqual([]);

    h.updateThread({
      messages: [message(`Created: [acme/app#42](${url})`)],
      pullRequests: [{ pullRequest, source: "manual", linkedAt: now }],
    });
    await Effect.runPromise(h.recovery.sweep);
    expect(h.lookups()).toBe(0);
    expect(h.commands).toEqual([]);
  });

  it("does not treat a reference to somebody else's created PR as creation intent", async () => {
    const h = await harness();
    h.updateThread({
      messages: [message(`Reviewed the PR created by another contributor: [#42](${url}).`)],
    });

    await Effect.runPromise(h.recovery.sweep);

    expect(h.commands[0]).toMatchObject({
      type: "thread.meta.update",
      pullRequestSource: "recovered",
    });
  });

  it("does not attach a PR reported by a review workflow thread", async () => {
    const h = await harness();
    h.updateThread({
      reviewSnapshot: { scope: { kind: "pull-request" } } as never,
    });

    await Effect.runPromise(h.recovery.recover(threadId));
    await Effect.runPromise(h.recovery.sweep);

    expect(h.commands).toEqual([]);
    expect(h.lookups()).toBe(0);
  });

  it("retries a not-yet-visible PR using fresh status", async () => {
    const h = await harness();
    h.setStatus({ ...status, pr: null });
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toEqual([]);
    h.setStatus(status);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toHaveLength(1);
    expect(h.lookups()).toBe(2);
  });

  it("never substitutes a branch PR for a different reported URL", async () => {
    const h = await harness();
    h.updateThread({ messages: [message("PR: https://github.com/other/repo/pull/42")] });
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toEqual([]);
  });

  it("recovers Enterprise PRs only when the complete checkout URL matches", async () => {
    const h = await harness();
    const enterpriseUrl = "https://github.acme.test/acme/app/pull/42";
    h.updateThread({ messages: [message(enterpriseUrl)] });
    await Effect.runPromise(h.recovery.sweep);
    expect(h.commands).toEqual([]);
    h.setStatus({ ...status, pr: { ...status.pr!, url: enterpriseUrl } });
    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest?.url).toBe(enterpriseUrl);
  });

  it("retries completed PR output during a newer stream", async () => {
    const h = await harness();
    h.setFailure(true);
    await Effect.runPromise(h.recovery.sweep);
    h.updateThread({ messages: [message(), { ...message("Working"), streaming: true }] });
    h.setFailure(false);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest).toEqual(status.pr);
  });

  it("retries failures rather than permanently marking the message handled", async () => {
    const h = await harness();
    h.setFailure(true);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest).toBeFalsy();
    h.setFailure(false);
    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest).toEqual(status.pr);
  });

  it("preserves an explicit association made while Git status is in flight", async () => {
    const h = await harness();
    const explicit = { ...status.pr!, number: 43, url: "https://github.com/acme/app/pull/43" };
    h.onLookup(() =>
      h.updateThread({
        pullRequest: explicit,
        updatedAt: "2026-09-08T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest).toEqual(explicit);
  });

  it("skips existing associations, archived threads, and missing intent without Git calls", async () => {
    const h = await harness();
    for (const update of [
      {
        pullRequest: status.pr,
        pullRequests: [
          {
            pullRequest: status.pr!,
            source: "created" as const,
            linkedAt: now,
          },
        ],
      },
      { pullRequest: null, archivedAt: now },
      { archivedAt: null, messages: [message("Done")] },
    ]) {
      h.updateThread(update);
      await Effect.runPromise(h.recovery.sweep);
    }
    expect(h.lookups()).toBe(0);
    expect(h.commands).toEqual([]);
  });

  it("does not downgrade explicit link provenance during recovery", async () => {
    const h = await harness();
    h.updateThread({
      pullRequest: status.pr,
      pullRequests: [
        {
          pullRequest: status.pr!,
          source: "created",
          linkedAt: now,
        },
      ],
    });

    await Effect.runPromise(h.recovery.sweep);

    expect(h.lookups()).toBe(0);
    expect(h.commands).toEqual([]);
    expect(h.thread()?.pullRequests).toEqual([
      {
        pullRequest: status.pr,
        source: "created",
        linkedAt: now,
      },
    ]);
  });

  it("rejects default branches and changed checkouts", async () => {
    const h = await harness();
    for (const update of [{ isDefaultBranch: true }, { branch: "other" }]) {
      h.setStatus({ ...status, ...update });
      await Effect.runPromise(h.recovery.sweep);
    }
    expect(h.commands).toEqual([]);
  });

  it("keeps rate-limited requests pending until Retry-After, then retries after restart once", async () => {
    const h = await harness();
    const retryAt = new Date(Date.parse(now) + 60_000).toISOString();
    h.setPendingIntent(pendingIntent());
    h.setResolveFailure(
      new GitHubCliError({
        operation: "getPullRequest",
        detail: "API rate limit exceeded",
        retryAfterAt: retryAt,
      }),
    );

    await Effect.runPromise(h.recovery.sweep);
    expect(h.thread()?.pullRequest).toBeFalsy();
    expect(h.thread()?.pendingPullRequestAssociation).toMatchObject({
      status: "pending",
      nextAttemptAt: retryAt,
    });
    expect(h.resolveLookups()).toBe(1);

    await h.restart();
    await Effect.runPromise(h.recovery.sweep);
    expect(h.resolveLookups()).toBe(1);

    h.advanceTo(retryAt);
    h.setResolveFailure(null);
    await h.restart();
    await Effect.runPromise(h.recovery.sweep);
    await Effect.runPromise(h.recovery.sweep);

    expect(h.resolveLookups()).toBe(2);
    expect(h.thread()?.pullRequest).toEqual(status.pr);
    expect(h.thread()?.pendingPullRequestAssociation).toBeNull();
  });

  it("associates an explicit pending reference without assistant-output inference", async () => {
    const h = await harness();
    h.updateThread({ messages: [] });
    h.setPendingIntent(pendingIntent());

    await Effect.runPromise(h.recovery.sweep);

    expect(h.thread()?.pendingPullRequestAssociation).toBeFalsy();
    expect(h.thread()?.pullRequest).toEqual(status.pr);
    expect(h.thread()?.pendingPullRequestAssociation).toBeNull();
    expect(h.commands).toContainEqual(
      expect.objectContaining({
        type: "thread.meta.update",
        threadId,
        pullRequest: status.pr,
        pullRequestOwnership: "transfer",
        pendingPullRequestAssociation: null,
      }),
    );
  });

  it("blocks repository and head mismatches without setting a successful association", async () => {
    for (const [pullRequest, reason] of [
      [{ ...status.pr!, url: "https://github.com/other/app/pull/42" }, "repository-mismatch"],
      [{ ...status.pr!, headBranch: "other" }, "head-mismatch"],
    ] as const) {
      const h = await harness();
      h.setPendingIntent(pendingIntent());
      h.setResolvedPullRequest(pullRequest);

      await Effect.runPromise(h.recovery.sweep);

      expect(h.thread()?.pullRequest).toBeFalsy();
      expect(h.thread()?.pendingPullRequestAssociation).toMatchObject({
        status: "blocked",
        reason,
      });
    }
  });

  it("does not transfer after a competing association supersedes the pending request", async () => {
    const h = await harness();
    const competing = {
      ...status.pr!,
      number: 43,
      url: "https://github.com/acme/app/pull/43",
    };
    h.setPendingIntent(pendingIntent());
    h.onResolve(() =>
      h.updateThread({
        pullRequest: competing,
        pendingPullRequestAssociation: null,
        updatedAt: "2026-09-08T00:00:01.000Z",
      }),
    );

    await Effect.runPromise(h.recovery.sweep);

    expect(h.thread()?.pullRequest).toEqual(competing);
    expect(h.commands).toEqual([]);
  });
});
