import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  approvalRedirectNotice,
  folderMoveBlockReason,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
  runThreadMove,
  folderMoveMenuBlockReason,
  splitInlineCode,
  threadMoveConfirmMessage,
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

// The toast and the slash menu give a draft the same sentence.
const draftReason =
  "Press Esc, then pick the project in the heading above the composer before the first message.";

it("folderMoveBlockReason refuses locally in a local draft and with context", () => {
  const ready = {
    supported: true,
    isLocalDraftThread: false,
    editingQueuedMessage: false,
    requestPending: false,
    textOnly: true,
  };
  expect(folderMoveBlockReason({ ...ready, isLocalDraftThread: true })).toBe(draftReason);
  expect(folderMoveBlockReason({ ...ready, textOnly: false })).toMatch(/attachments/);
});

it("folderMoveMenuBlockReason names the first thing that blocks a move", () => {
  const free = {
    isLocalDraftThread: false,
    editingQueuedMessage: false,
    requestPending: false,
    running: false,
  };
  expect(folderMoveMenuBlockReason(free)).toBeNull();
  expect(folderMoveMenuBlockReason({ ...free, running: true })).toMatch(/still working/);
  expect(folderMoveMenuBlockReason({ ...free, running: true, requestPending: true })).toMatch(
    /pending question/,
  );
  expect(folderMoveMenuBlockReason({ ...free, running: true, isLocalDraftThread: true })).toBe(
    draftReason,
  );
});

it("splitInlineCode gives each path its own part and keeps the text around it", () => {
  expect(splitInlineCode("Busy.")).toEqual([{ code: false, text: "Busy.", offset: 0 }]);
  expect(splitInlineCode("No folder at `/a b/c`.")).toEqual([
    { code: false, text: "No folder at ", offset: 0 },
    { code: true, text: "/a b/c", offset: 13 },
    { code: false, text: ".", offset: 21 },
  ]);
  expect(splitInlineCode("The folder `/s` is a scratch folder. Use /no.")).toEqual([
    { code: false, text: "The folder ", offset: 0 },
    { code: true, text: "/s", offset: 11 },
    { code: false, text: " is a scratch folder. Use /no.", offset: 15 },
  ]);
  // The receipt writes a path with a backtick in double backticks.
  expect(splitInlineCode("The next turn runs in `` /repos/b`c ``.")).toEqual([
    { code: false, text: "The next turn runs in ", offset: 0 },
    { code: true, text: "/repos/b`c", offset: 22 },
    { code: false, text: ".", offset: 38 },
  ]);
});

const threadId = ThreadId.make("thread-1");
const request: ThreadMoveInput = { threadId, destination: "app" };
const needsProject = { _tag: "needs-project", folder: "/repo/app" } as const;
const confirm = {
  _tag: "confirm",
  from: "/worktrees/w",
  to: "/repo/app",
  staysOnDisk: "The worktree stays on disk at /worktrees/w.",
  wayBack: "add-project",
  otherThreads: [{ threadId, title: "Fork" }],
} as const satisfies ThreadMoveResult;
const moved = { _tag: "moved", folder: "/repo/app", members: [] } as const;

it("runThreadMove asks each question once, keeps every flag, sends back the folders it showed, and stops at a decline", async () => {
  const calls: ThreadMoveInput[] = [];
  const answers: ReadonlyArray<ThreadMoveResult> = [needsProject, confirm, moved];
  const move = async (input: ThreadMoveInput) => answers[calls.push(input) - 1]!;
  expect(await runThreadMove(request, move, async () => true)).toBe(moved);
  const approved = { from: "/worktrees/w", to: "/repo/app" };
  expect(calls).toEqual([
    request,
    { ...request, addProject: true, approved: { to: "/repo/app" } },
    { ...request, addProject: true, confirm: true, approved },
  ]);

  calls.length = 0;
  expect(await runThreadMove(request, move, async (q) => q._tag === "needs-project")).toBeNull();
  expect(calls).toHaveLength(2);
  const refused = { _tag: "refused", reason: "A member is busy." } as const;
  const ask = () => Promise.reject<boolean>(new Error("asked"));
  expect(await runThreadMove(request, async () => refused, ask)).toBe(refused);
});

// A confirm message is the title, a line for each folder, an empty line, then the notes.
const readConfirm = (message: string) => {
  const [title = "", ...lines] = message.split("\n");
  const gap = lines.indexOf("");
  return {
    title,
    folders: lines.slice(0, gap).map((line) => line.slice(line.indexOf(": ") + 2)),
    notes: lines.slice(gap + 1).join("\n"),
  };
};

// The confirm dialog takes its title from the first line, so the question leads each message.
it("threadMoveConfirmMessage names nesting, both folders once, the way back and threads", () => {
  const nestedIn = { projectId: ProjectId.make("p"), title: "App" };
  const nested = readConfirm(threadMoveConfirmMessage({ ...needsProject, nestedIn }, "/repo"));
  expect(nested.folders).toEqual(["/repo", "/repo/app"]);
  expect(nested.notes).toContain("App");
  // Without a known current folder, only the destination has a line. Without nesting, no project.
  expect(readConfirm(threadMoveConfirmMessage(needsProject, null))).toEqual({
    title: nested.title,
    folders: ["/repo/app"],
    notes: expect.not.stringContaining("App"),
  });

  const stays = "stays on disk with all its files until you remove it.";
  const leaving = { ...confirm, staysOnDisk: `The folder /worktrees/w ${stays}` };
  const scratch = readConfirm(
    threadMoveConfirmMessage({ ...leaving, to: null, wayBack: "none" }, null),
  );
  const worktree = readConfirm(threadMoveConfirmMessage(leaving, null));
  const rooted = readConfirm(threadMoveConfirmMessage({ ...leaving, wayBack: "cd" }, null));
  // A new scratch folder has no path yet.
  expect(scratch.folders).toEqual(["/worktrees/w", expect.not.stringContaining("/")]);
  expect(worktree.folders).toEqual(["/worktrees/w", "/repo/app"]);
  expect(rooted.folders).toEqual(worktree.folders);
  for (const { notes } of [scratch, worktree, rooted]) {
    // The server's sentence stays, without the path that the From line shows.
    expect(notes).toContain(`The folder ${stays}`);
    expect(notes).toContain("Fork");
  }
  // Each way back has its own note, and only a folder with a way back names /cd.
  expect(new Set([scratch.notes, worktree.notes, rooted.notes]).size).toBe(3);
  expect(scratch.notes).not.toContain("/cd");
  expect(worktree.notes).toContain("/cd");
  expect(rooted.notes).toContain("/cd");
  // A new project, a scratch folder and a worktree each have their own question.
  expect(rooted.title).toBe(worktree.title);
  expect(new Set([nested.title, scratch.title, worktree.title]).size).toBe(3);
  for (const { title, folders, notes } of [nested, scratch, worktree, rooted]) {
    expect(title).toMatch(/^[^/]+\?$/);
    for (const folder of folders) expect(notes).not.toContain(folder);
  }
});
