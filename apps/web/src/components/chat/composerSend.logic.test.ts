import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { startFanoutThread } from "./chatViewSend";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import {
  approvalRedirectNotice,
  linkCheckedOutPullRequest,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

describe("referencedThreadContexts", () => {
  it("keeps only the attached threads the prompt still links", () => {
    const prompt = `see ${formatInlineContextReference(threadContextReference(remoteThread))}`;
    expect(
      referencedThreadContexts({ prompt, threadContexts: [localThread, remoteThread] }),
    ).toEqual([remoteThread]);
  });
});

describe("loadBalancingSendWarning", () => {
  it("asks the user to wait while resource checks run", () => {
    expect(
      loadBalancingSendWarning({
        pending: true,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [],
      }).title,
    ).toBe("Checking machine resources");
  });

  it("blames the attached threads when no machine can read all of them", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [local, remote],
      }).description,
    ).toMatch(/No machine can read every attached thread/);
  });

  it("blames resources when one machine can read every attached thread", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread],
        candidateEnvironmentIds: [remote, local],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});

describe("multipleModelSendBlock", () => {
  const ready = {
    selectionCount: 2,
    serverSupportsWorktreeBootstrap: true,
    isLocalDraftThread: true,
    isGitRepo: true,
    branch: "main",
  };

  it("lets a new Git draft with a branch and models start", () => {
    expect(multipleModelSendBlock(ready)).toBeNull();
  });

  it("asks for a server update before checking the draft", () => {
    expect(
      multipleModelSendBlock({
        ...ready,
        serverSupportsWorktreeBootstrap: false,
        isGitRepo: false,
      }),
    ).toBe("server-outdated");
  });

  it.each([
    { isLocalDraftThread: false },
    { isGitRepo: false },
    { branch: null },
    { selectionCount: 0 },
  ])("needs a new Git thread with a branch and models (%o)", (override) => {
    expect(multipleModelSendBlock({ ...ready, ...override })).toBe("needs-new-git-thread");
  });
});

describe("approvalRedirectNotice", () => {
  const settled = {
    draftChanged: false,
    declined: true,
    approvalResponding: false,
    approvalArrived: false,
  };

  it("says the decline went through when the draft changed after it", () => {
    expect(approvalRedirectNotice({ ...settled, draftChanged: true })).toBe(
      "Approval declined. Your message changed, so it wasn't sent.",
    );
    expect(approvalRedirectNotice({ ...settled, draftChanged: true, declined: false })).toBe(
      "Your message changed, so it wasn't sent.",
    );
  });

  it("explains an approval already being answered", () => {
    expect(
      approvalRedirectNotice({ ...settled, declined: false, approvalResponding: true }),
    ).toMatch(/already being answered/);
  });

  it("explains an approval that arrived during the decline", () => {
    expect(approvalRedirectNotice({ ...settled, approvalArrived: true })).toMatch(
      /Another approval arrived/,
    );
  });

  it("stays quiet when the decline failed or the user left the thread", () => {
    expect(approvalRedirectNotice({ ...settled, declined: false })).toBeNull();
    expect(approvalRedirectNotice(settled)).toBeNull();
  });
});

// #15721: threads are created from a pull request checkout only on send, so each one that starts
// is linked to the checked-out pull request afterwards.
describe("linkCheckedOutPullRequest", () => {
  const pullRequestUrl = "https://github.com/pingdotgg/t3code/pull/123";
  const fakeLinking = (options: { canLink?: boolean; fail?: boolean } = {}) => {
    const links: Array<[ScopedThreadRef, string]> = [];
    const failures: unknown[] = [];
    return {
      links,
      failures,
      onLinkFailed: (error: unknown) => failures.push(error),
      linking: {
        canLink: () => options.canLink ?? true,
        changeLink: async (threadRef: ScopedThreadRef, url: string) => {
          if (options.fail) throw new Error("link rejected");
          links.push([threadRef, url]);
        },
      },
    };
  };
  const threadRef = scopeThreadRef(local, ThreadId.make("started"));

  it("links the started thread and reports a rejected link without throwing", async () => {
    const linked = fakeLinking();
    await linkCheckedOutPullRequest({ threadRef, pullRequestUrl, ...linked });
    expect(linked.links).toEqual([[threadRef, pullRequestUrl]]);

    const rejected = fakeLinking({ fail: true });
    await linkCheckedOutPullRequest({ threadRef, pullRequestUrl, ...rejected });
    expect(rejected.failures).toEqual([new Error("link rejected")]);
  });

  it("skips drafts without a pull request and environments that cannot link it", async () => {
    const withoutPullRequest = fakeLinking();
    await linkCheckedOutPullRequest({ threadRef, pullRequestUrl: null, ...withoutPullRequest });
    const unsupported = fakeLinking({ canLink: false });
    await linkCheckedOutPullRequest({ threadRef, pullRequestUrl, ...unsupported });
    expect([...withoutPullRequest.links, ...unsupported.links]).toEqual([]);
  });

  it("links only the models that started when another model fails", async () => {
    const linked = fakeLinking();
    const attempted: ThreadId[] = [];
    const uncertainSubmissions = new Map<string, ThreadId>();
    await Promise.all(
      ["ok", "fails"].map((model) =>
        startFanoutThread({
          retryKey: model,
          model,
          uncertainSubmissions,
          start: async (threadId) => {
            attempted.push(threadId);
            if (model === "fails") throw new Error("provider unavailable");
            return AsyncResult.success(undefined);
          },
          openThread: () => undefined,
          onStarted: (threadId) =>
            void linkCheckedOutPullRequest({
              threadRef: scopeThreadRef(local, threadId),
              pullRequestUrl,
              ...linked,
            }),
        }),
      ),
    );
    expect(linked.links).toEqual([[scopeThreadRef(local, attempted[0]!), pullRequestUrl]]);
  });
});
