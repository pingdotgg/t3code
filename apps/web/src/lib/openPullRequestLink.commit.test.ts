import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  GitCommandError,
  ProjectId,
  RunId,
  ThreadId,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";
import type { AtomCommandResult, AtomQueryOptions } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  openInApp: true,
  threadExists: true,
  repositoryKey: "github.com/pingdotgg/t3code",
  projectEnvironmentId: "local",
  worktreePath: null as string | null,
  previewCache: new Map<string, Promise<AtomCommandResult<ReviewDiffPreviewResult, unknown>>>(),
  preview:
    vi.fn<
      (target: {
        environmentId: EnvironmentId;
        input: ReviewDiffPreviewInput;
      }) => Promise<AtomCommandResult<ReviewDiffPreviewResult, unknown>>
    >(),
  openLink: vi.fn<() => Promise<void>>(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: {
      pullRequestLinksOpenInApp: boolean;
      diffIgnoreWhitespace: boolean;
    }) => unknown,
  ) => select({ pullRequestLinksOpenInApp: state.openInApp, diffIgnoreWhitespace: true }),
}));
vi.mock("../state/review", () => ({ reviewEnvironment: { diffPreview: {} } }));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner:
    (_family: unknown, options?: AtomQueryOptions) =>
    (target: Parameters<typeof state.preview>[0]) => {
      const key = JSON.stringify(target);
      const cached = state.previewCache.get(key);
      if (cached && !options?.refresh) return cached;
      const result = state.preview(target);
      state.previewCache.set(key, result);
      return result;
    },
}));
vi.mock("../browser/useOpenLink", () => ({ useOpenLink: () => state.openLink }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => new Map([["local", { environment: { capabilities: { pullRequests: true } } }]]),
  },
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: {} }));
vi.mock("../state/entities", () => ({
  readThreadShell: (ref: { environmentId: string; threadId: string }) =>
    state.threadExists && ref.environmentId === "local" && ref.threadId === "thread"
      ? { environmentId: "local", projectId: "project", worktreePath: state.worktreePath }
      : null,
  readProject: (ref: { environmentId: string; projectId: string }) =>
    ref.environmentId === state.projectEnvironmentId && ref.projectId === "project"
      ? project()
      : null,
  readProjects: () => [project()],
}));

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useOpenChangeRequestLink } from "./openPullRequestLink";

const ref = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread"));
const sha = "5235a682169a69d18261c8bf4f1017dfb01b28fe";
const commitUrl = `https://github.com/pingdotgg/t3code/pull/19941/commits/${sha}`;

function project() {
  return {
    id: ProjectId.make("project"),
    environmentId: EnvironmentId.make(state.projectEnvironmentId),
    workspaceRoot: "/workspace/project",
    repositoryIdentity: {
      provider: "github",
      canonicalKey: state.repositoryKey,
      displayName: state.repositoryKey.split("/").slice(1).join("/"),
      locator: { remoteUrl: `https://${state.repositoryKey}.git` },
    },
  };
}

function previewResult(commitSha = sha): ReviewDiffPreviewResult {
  return {
    cwd: "/workspace/project",
    generatedAt: DateTime.makeUnsafe(0),
    sources: [
      {
        id: commitSha,
        kind: "commit",
        title: `Commit ${commitSha.slice(0, 7)}`,
        baseRef: "parent",
        headRef: commitSha,
        diff: "",
        files: [],
        diffHash: "hash",
        truncated: false,
      },
    ],
  };
}

function click(modifiers = {}) {
  return {
    metaKey: false,
    ctrlKey: false,
    button: 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    ...modifiers,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  state.openInApp = true;
  state.threadExists = true;
  state.repositoryKey = "github.com/pingdotgg/t3code";
  state.projectEnvironmentId = "local";
  state.worktreePath = null;
  state.previewCache.clear();
  state.preview.mockReset().mockResolvedValue(AsyncResult.success(previewResult()));
  state.openLink.mockReset().mockResolvedValue(undefined);
  state.navigate.mockReset();
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

describe("commit link opening", () => {
  it("opens a port-bearing GitHub Enterprise URL for its normalized repository key", async () => {
    state.repositoryKey = "github.acme.test/team/repo";
    expect(
      useOpenChangeRequestLink(ref)(
        click(),
        `https://github.acme.test:8443/team/repo/commit/${sha}`,
      ),
    ).toBe(true);
    await state.preview.mock.results[0]?.value;
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe("diff");
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "commit",
      sha,
      baseRef: null,
    });
  });

  it.each([commitUrl, `https://github.com/pingdotgg/t3code/commit/${sha}`])(
    "opens the Diff panel with the commit and saved base: %s",
    async (url) => {
      useDiffPanelStore.getState().selectBranchBaseRef(ref, "origin/main");
      const event = click();
      expect(useOpenChangeRequestLink(ref)(event, url)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      await state.preview.mock.results[0]?.value;
      expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe("diff");
      expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual(
        {
          kind: "commit",
          sha,
          baseRef: "origin/main",
        },
      );
    },
  );

  it.each([{ metaKey: true }, { ctrlKey: true }, { button: 1 }])(
    "leaves modified clicks to the original URL: %s",
    (modifiers) => {
      const event = click(modifiers);
      expect(useOpenChangeRequestLink(ref)(event, commitUrl)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(useRightPanelStore.getState().byThreadKey).toEqual({});
      expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
    },
  );

  it.each([
    "preference off",
    "missing thread",
    "wrong repository",
    "wrong host",
    "wrong environment",
  ])("falls back without changing either panel for %s", (scenario) => {
    if (scenario === "preference off") state.openInApp = false;
    if (scenario === "missing thread") state.threadExists = false;
    if (scenario === "wrong repository") state.repositoryKey = "github.com/pingdotgg/other";
    if (scenario === "wrong host") state.repositoryKey = "github.internal/pingdotgg/t3code";
    if (scenario === "wrong environment") state.projectEnvironmentId = "remote";
    const event = click();
    expect(useOpenChangeRequestLink(ref)(event, commitUrl)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
  });

  it("does not use a synthetic PR panel or a matching project without a real thread", () => {
    const event = click();
    expect(useOpenChangeRequestLink(undefined, ref)(event, commitUrl)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("opens a matching real thread supplied by the desktop link handler", async () => {
    expect(useOpenChangeRequestLink()(click(), commitUrl, ref)).toBe(true);
    await state.preview.mock.results[0]?.value;
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe("diff");
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "commit",
      sha,
      baseRef: null,
    });
  });

  it.each([null, "/workspace/worktrees/feature"])(
    "keeps the file panel until commit validation succeeds in %s",
    async (worktreePath) => {
      state.worktreePath = worktreePath;
      const preview = deferred<AtomCommandResult<ReviewDiffPreviewResult, unknown>>();
      state.preview.mockReturnValueOnce(preview.promise);
      useRightPanelStore.getState().openFile(ref, "README.md");
      useDiffPanelStore.getState().selectBranchBaseRef(ref, "origin/main");
      const panel = useRightPanelStore.getState().byThreadKey;
      const selection = useDiffPanelStore.getState().byThreadKey;
      const event = click();

      expect(useOpenChangeRequestLink(ref)(event, commitUrl)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(useRightPanelStore.getState().byThreadKey).toBe(panel);
      expect(useDiffPanelStore.getState().byThreadKey).toBe(selection);
      expect(state.preview).toHaveBeenCalledExactlyOnceWith({
        environmentId: ref.environmentId,
        input: {
          cwd: worktreePath ?? "/workspace/project",
          baseRef: "origin/main",
          commitSha: sha,
          ignoreWhitespace: true,
        },
      });

      preview.resolve(AsyncResult.success(previewResult()));
      await preview.promise;
      expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe("diff");
      expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual(
        {
          kind: "commit",
          sha,
          baseRef: "origin/main",
        },
      );
      expect(state.openLink).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "off branch", "no commit source"])(
    "opens the original %s commit URL externally without changing the current panel",
    async (scenario) => {
      const preview = deferred<AtomCommandResult<ReviewDiffPreviewResult, unknown>>();
      const opened = deferred<void>();
      state.preview.mockReturnValueOnce(preview.promise);
      state.openLink.mockImplementationOnce(async () => opened.resolve());
      useRightPanelStore.getState().openFile(ref, "README.md");
      useDiffPanelStore.getState().selectBranchBaseRef(ref, "origin/main");
      const panel = useRightPanelStore.getState().byThreadKey;
      const selection = useDiffPanelStore.getState().byThreadKey;
      const event = click();
      const originalUrl = `${commitUrl}?diff=split#diff-1`;

      expect(useOpenChangeRequestLink(ref)(event, originalUrl)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(useRightPanelStore.getState().byThreadKey).toBe(panel);
      expect(useDiffPanelStore.getState().byThreadKey).toBe(selection);

      preview.resolve(
        scenario === "no commit source"
          ? AsyncResult.success({ ...previewResult(), sources: [] })
          : AsyncResult.failure(
              Cause.fail(
                new GitCommandError({
                  operation: "GitVcsDriver.reviewCommit.reachable",
                  command: "git merge-base",
                  cwd: "/workspace/project",
                  detail: scenario,
                }),
              ),
            ),
      );
      await opened.promise;
      expect(state.openLink).toHaveBeenCalledExactlyOnceWith(originalUrl, {
        event: { metaKey: true, ctrlKey: false },
        threadRef: ref,
      });
      expect(useRightPanelStore.getState().byThreadKey).toBe(panel);
      expect(useDiffPanelStore.getState().byThreadKey).toBe(selection);
    },
  );

  it("opens a repeated commit link externally when the commit becomes unavailable", async () => {
    const openCommit = useOpenChangeRequestLink(ref);
    expect(openCommit(click(), commitUrl)).toBe(true);
    await state.preview.mock.results[0]?.value;
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe("diff");

    state.preview.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Missing commit"))));
    useRightPanelStore.getState().openFile(ref, "README.md");
    const panel = useRightPanelStore.getState().byThreadKey;
    const selection = useDiffPanelStore.getState().byThreadKey;

    expect(openCommit(click(), commitUrl)).toBe(true);
    await state.preview.mock.results.at(-1)?.value;

    expect(state.openLink).toHaveBeenCalledExactlyOnceWith(commitUrl, {
      event: { metaKey: true, ctrlKey: false },
      threadRef: ref,
    });
    expect(useRightPanelStore.getState().byThreadKey).toBe(panel);
    expect(useDiffPanelStore.getState().byThreadKey).toBe(selection);
  });

  it.each(["success", "failure"])("ignores a late commit %s after a PR opens", async (outcome) => {
    const preview = deferred<AtomCommandResult<ReviewDiffPreviewResult, unknown>>();
    state.preview.mockReturnValueOnce(preview.promise);
    const openCommit = useOpenChangeRequestLink(ref);
    const openPr = useOpenChangeRequestLink(ref);
    expect(openCommit(click(), commitUrl)).toBe(true);
    expect(openPr(click(), "https://github.com/pingdotgg/t3code/pull/19941")).toBe(true);
    const panel = useRightPanelStore.getState().byThreadKey;
    const selection = useDiffPanelStore.getState().byThreadKey;

    preview.resolve(
      outcome === "success"
        ? AsyncResult.success(previewResult())
        : AsyncResult.failure(Cause.fail(new Error("Missing commit"))),
    );
    await preview.promise;

    expect(useRightPanelStore.getState().byThreadKey).toBe(panel);
    expect(useDiffPanelStore.getState().byThreadKey).toBe(selection);
    expect(state.openLink).not.toHaveBeenCalled();
  });

  it.each([
    ["older first", "success"],
    ["newer first", "success"],
    ["older first", "failure"],
    ["newer first", "failure"],
  ])("keeps the newer commit when %s completes with an older %s", async (order, outcome) => {
    const older = deferred<AtomCommandResult<ReviewDiffPreviewResult, unknown>>();
    const newer = deferred<AtomCommandResult<ReviewDiffPreviewResult, unknown>>();
    const newerSha = "6".repeat(40);
    state.preview.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    useRightPanelStore.getState().openFile(ref, "README.md");
    const panel = useRightPanelStore.getState().byThreadKey;
    const selection = useDiffPanelStore.getState().byThreadKey;
    const openOlder = useOpenChangeRequestLink(ref);
    const openNewer = useOpenChangeRequestLink(ref);
    expect(openOlder(click(), commitUrl)).toBe(true);
    expect(openNewer(click(), `https://github.com/pingdotgg/t3code/commit/${newerSha}`)).toBe(true);
    expect(useRightPanelStore.getState().byThreadKey).toBe(panel);
    expect(useDiffPanelStore.getState().byThreadKey).toBe(selection);
    const olderResult: AtomCommandResult<ReviewDiffPreviewResult, unknown> =
      outcome === "success"
        ? AsyncResult.success(previewResult())
        : AsyncResult.failure(Cause.fail(new Error("Missing commit")));

    if (order === "older first") {
      older.resolve(olderResult);
      await older.promise;
      expect(useRightPanelStore.getState().byThreadKey).toBe(panel);
      expect(useDiffPanelStore.getState().byThreadKey).toBe(selection);
    }
    newer.resolve(AsyncResult.success(previewResult(newerSha)));
    await newer.promise;
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "commit",
      sha: newerSha,
      baseRef: null,
    });
    if (order === "newer first") {
      older.resolve(olderResult);
      await older.promise;
    }
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe("diff");
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "commit",
      sha: newerSha,
      baseRef: null,
    });
    expect(state.openLink).not.toHaveBeenCalled();
  });

  it.each(
    ["unstaged", "turn", "commit", "base"].flatMap((selection) =>
      ["success", "failure"].map((outcome) => ({ selection, outcome })),
    ),
  )("keeps a newer $selection selection after a late $outcome", async ({ selection, outcome }) => {
    const preview = deferred<AtomCommandResult<ReviewDiffPreviewResult, unknown>>();
    state.preview.mockReturnValueOnce(preview.promise);
    useRightPanelStore.getState().open(ref, "diff");
    expect(useOpenChangeRequestLink(ref)(click(), commitUrl)).toBe(true);

    const store = useDiffPanelStore.getState();
    if (selection === "unstaged") store.selectGitScope(ref, "unstaged");
    else if (selection === "turn") store.selectTurn(ref, RunId.make("picker-turn"));
    else if (selection === "commit") store.selectCommit(ref, "6".repeat(40));
    else store.selectBranchBaseRef(ref, "origin/release");
    const chosen = selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref);
    const panel = useRightPanelStore.getState().byThreadKey;

    preview.resolve(
      outcome === "success"
        ? AsyncResult.success(previewResult())
        : AsyncResult.failure(Cause.fail(new Error("Missing commit"))),
    );
    await preview.promise;

    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toBe(
      chosen,
    );
    expect(useRightPanelStore.getState().byThreadKey).toBe(panel);
    expect(state.openLink).not.toHaveBeenCalled();
  });

  it("still opens ordinary PR links in the PR panel", () => {
    expect(
      useOpenChangeRequestLink(ref)(click(), "https://github.com/pingdotgg/t3code/pull/19941"),
    ).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe(
      "pull-request",
    );
    expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
  });
});
