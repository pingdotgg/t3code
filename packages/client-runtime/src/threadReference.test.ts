import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import {
  decodeComposerContextFragment,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadReferenceCopyTarget, threadChipsCopyTarget } from "./threadReference.ts";

const thread = {
  threadRef: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
  title: "Fix the login flow",
};

const crossRepositoryPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "other/repo",
  number: 42,
  url: "https://github.com/other/repo/pull/42",
  source: "manual",
  linkedAt: "2026-01-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

describe("resolveThreadReferenceCopyTarget", () => {
  it("does not copy another reference while the open panel URL is unavailable", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        ...thread,
        openPanelPullRequestUrl: null,
        pullRequests: [crossRepositoryPullRequest],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toBeNull();
  });

  it("prefers the open panel pull request over the thread pull request", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        ...thread,
        openPanelPullRequestUrl: "https://github.com/t3/pr/14",
        pullRequests: [crossRepositoryPullRequest],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({
      kind: "pull-request",
      value: "https://github.com/t3/pr/14",
      successTitle: "PR link copied",
    });
  });

  it.each([null, "https://github.com/t3/pr/12"])(
    "copies a native cross-repository link before the fallback URL %s",
    (linkedPullRequestUrl) => {
      expect(
        resolveThreadReferenceCopyTarget({
          ...thread,
          pullRequests: [crossRepositoryPullRequest],
          linkedPullRequestUrl,
        }),
      ).toMatchObject({
        kind: "pull-request",
        value: crossRepositoryPullRequest.url,
      });
    },
  );

  it("uses the fallback URL when native links are dismissed", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        ...thread,
        pullRequests: [{ ...crossRepositoryPullRequest, source: "stack-dismissed" }],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({ kind: "pull-request", value: "https://github.com/t3/pr/12" });
  });

  it("copies a thread chip that pastes back as the same thread on its machine", () => {
    const target = resolveThreadReferenceCopyTarget({ ...thread, linkedPullRequestUrl: null });

    expect(target).toMatchObject({
      kind: "thread",
      description: "Fix the login flow",
      successTitle: "Thread copied",
    });
    const pasted = decodeComposerContextFragment(encodeComposerContextFragment(target!.fragment!));
    expect(pasted).toEqual({
      version: 1,
      source: { environmentId: "env-1" },
      records: [
        expect.objectContaining({
          kind: "thread",
          environmentId: "env-1",
          threadId: "thread-1",
          title: "Fix the login flow",
        }),
      ],
    });
    // A paste keeps only the records its plain text references.
    expect(collectComposerContextReferences(target!.value)).toEqual([
      expect.objectContaining({
        kind: "thread",
        contextId: pasted!.records[0]!.contextId,
        label: "Fix the login flow",
      }),
    ]);
  });

  it("copies several threads, across machines, as chips that paste back together", () => {
    const other = {
      threadRef: {
        environmentId: EnvironmentId.make("env-2"),
        threadId: ThreadId.make("thread-2"),
      },
      title: "Ship the release",
    };
    const target = threadChipsCopyTarget([thread, other]);

    expect(target).toMatchObject({ kind: "thread", successTitle: "2 threads copied" });
    const pasted = decodeComposerContextFragment(encodeComposerContextFragment(target.fragment!));
    expect(pasted?.records).toEqual([
      expect.objectContaining({ environmentId: "env-1", threadId: "thread-1" }),
      expect.objectContaining({ environmentId: "env-2", threadId: "thread-2" }),
    ]);
    expect(
      collectComposerContextReferences(target.value).map((reference) => reference.contextId),
    ).toEqual(pasted?.records.map((record) => record.contextId));
  });
});
