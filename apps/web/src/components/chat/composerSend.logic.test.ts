import { EnvironmentId, PipelineId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  activeDraftPipelineId,
  approvalRedirectNotice,
  commandIdForPipelineSend,
  PIPELINE_TEXT_ONLY_HINT,
  pipelineSendBlock,
  pipelineSendRetryKey,
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

describe("activeDraftPipelineId", () => {
  const pipelineId = PipelineId.make("pipeline-1");
  it("applies only in the environment it was chosen in", () => {
    expect(activeDraftPipelineId({ environmentId: local, pipelineId }, local)).toBe(pipelineId);
    expect(activeDraftPipelineId({ environmentId: local, pipelineId }, remote)).toBeNull();
    expect(activeDraftPipelineId(null, local)).toBeNull();
  });
});

describe("pipelineSendBlock", () => {
  it("allows text only", () => {
    expect(pipelineSendBlock({ attachmentCount: 0, hasContext: false })).toBeNull();
    expect(pipelineSendBlock({ attachmentCount: 1, hasContext: false })).toBe(
      PIPELINE_TEXT_ONLY_HINT,
    );
    expect(pipelineSendBlock({ attachmentCount: 0, hasContext: true })).toBe(
      PIPELINE_TEXT_ONLY_HINT,
    );
  });
});

describe("commandIdForPipelineSend", () => {
  const key = (text: string) =>
    pipelineSendRetryKey({
      routeKey: "r",
      pipelineId: "p",
      projectId: "proj",
      workspaceStrategy: { type: "root" },
      text,
    });
  it("reuses the id for the same attempt and mints a new one when the text changes", () => {
    const commands = new Map<string, string>();
    let next = 0;
    const make = () => `cmd-${(next += 1)}`;
    expect(commandIdForPipelineSend(commands, key("a"), make)).toBe("cmd-1");
    expect(commandIdForPipelineSend(commands, key("a"), make)).toBe("cmd-1");
    expect(commandIdForPipelineSend(commands, key("b"), make)).toBe("cmd-2");
  });
});
