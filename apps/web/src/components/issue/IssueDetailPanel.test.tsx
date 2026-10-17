// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  IssueTrackerKind,
  IssueDetail,
  ProjectId,
  IssueCandidatesInput,
  IssueCommentsPageInput,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type {
  IssueState,
  IssueRichBody,
  IssueComment,
  IssueCommentsPage,
  IssueReaction,
  IssueLinkedPullRequestsPage,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";

const decodeCandidatesInput = Schema.decodeUnknownSync(IssueCandidatesInput);

const state = vi.hoisted(() => ({
  detail: {
    projectId: "project",
    projectTitle: "Project",
    tracker: "github",
    host: "github.com",
    scope: "org/repo",
    key: "1",
    displayKey: "#1",
    title: "Issue",
    body: "",
    bodyEditable: undefined as boolean | undefined,
    richBody: undefined as IssueRichBody | undefined,
    connectionId: undefined as string | undefined,
    url: "https://github.com/org/repo/issues/1",
    author: null,
    viewer: null as string | null,
    reactions: undefined as ReadonlyArray<IssueReaction> | undefined,
    state: { category: "open", name: "open" } as IssueState,
    states: undefined as ReadonlyArray<IssueState> | undefined,
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    closedAt: null,
    labels: [],
    milestone: undefined as string | null | undefined,
    assignees: [],
    comments: [] as ReadonlyArray<IssueComment>,
    commentsCursor: null as string | null,
    events: [],
    linkedPullRequests: [],
    commentCount: 0,
    writable: true,
    viewerPermissions: {
      comment: true,
      edit: false,
      labels: false,
      assignees: false,
      setState: false,
    },
    capabilities: {
      create: false,
      edit: false,
      comment: true,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      search: true,
      linkedPullRequests: false,
      events: true,
      subIssues: false,
      updateParent: false,
      createSubIssue: false,
      editComment: false,
      states: [] as ReadonlyArray<IssueState>,
      closeReasons: [] as ReadonlyArray<string>,
    },
  },
  write: vi.fn(),
  commentsRead: vi
    .fn<({ input }: { input: IssueCommentsPageInput }) => Promise<IssueCommentsPage>>()
    .mockResolvedValue({ comments: [], nextCursor: null }),
  navigate: vi.fn(),
  detailRefresh: vi.fn(),
  projects: [] as EnvironmentProject[],
  allowed: true,
  writeAllowed: undefined as boolean | undefined,
  solve: vi.fn(),
  toast: vi.fn(),
  candidatesRead: vi.fn(),
  candidates: {
    data: null as { states: ReadonlyArray<IssueState> } | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));
vi.mock("~/state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("@t3tools/client-runtime/state/issues", async (importOriginal) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const commentPages = Atom.family((key: string) =>
    Atom.make(Effect.promise(() => state.commentsRead(JSON.parse(key)))).pipe(Atom.keepAlive),
  );
  const pages = Atom.family((_key: string) => {
    const value = Atom.make<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>(
      AsyncResult.success({ items: [], nextCursor: null }),
    ).pipe(Atom.keepAlive);
    return Atom.writable(
      (get) => get(value),
      (get, result: AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>) =>
        get.set(value, result),
      () => undefined,
    ).pipe(Atom.keepAlive);
  });
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/issues")>()),
    createIssueEnvironmentAtoms: () => ({
      linkedPullRequests: (target: unknown) => pages(JSON.stringify(target)),
      commentPages: (target: unknown) => commentPages(JSON.stringify(target)),
    }),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useCanGoBack: () => true,
  useNavigate: () => state.navigate,
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("./useIssueThreadHandoff", () => ({
  useIssueThreadHandoff: () => ({ pending: false, start: state.solve }),
}));
vi.mock("./IssueHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./IssueHistory")>()),
  IssueHistory: () => null,
}));
vi.mock("../pullRequest/PullRequestCommentBody", () => ({
  PullRequestCommentBody: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock("~/state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/query")>()),
  useEnvironmentQuery: (atom: { kind: string } | null) =>
    atom?.kind === "states"
      ? state.candidates
      : atom === null
        ? { ...state.candidates, data: null, error: null }
        : {
            data: state.detail,
            error: null,
            isPending: false,
            refresh: state.detailRefresh,
          },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.write }));
vi.mock("~/state/issues", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/state/issues")>();
  const { Atom } = await import("effect/reactivity");
  const command = { permissionAtom: () => Atom.make(state.writeAllowed ?? state.allowed) };
  const historyRevisions = Atom.family((_key: string) => Atom.make(0).pipe(Atom.keepAlive));
  return {
    issueEnvironment: {
      detail: () => ({ kind: "detail" }),
      historyRefresh: (target: unknown) => historyRevisions(JSON.stringify(target)),
      candidates: (target: unknown) => {
        state.candidatesRead(target);
        return { kind: "states" };
      },
      comment: command,
      create: command,
      update: command,
      setState: command,
      setParent: command,
      editComment: command,
    },
    useIssueHierarchy: () => ({
      extra: null,
      items: [],
      hasMore: false,
      isPending: false,
      error: null,
      loadMore: vi.fn(),
    }),
    useIssueLinkedPullRequests: original.useIssueLinkedPullRequests,
    useIssueComments: original.useIssueComments,
  };
});
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { formatRelativeTimeLabel } from "~/timestampFormat";

const encodeCommentPageInput = Schema.encodeSync(IssueCommentsPageInput);
const decodeCommentPageInput = Schema.decodeUnknownSync(IssueCommentsPageInput);
const decodeDetail = Schema.decodeUnknownSync(IssueDetail);

it.each([
  ["external", undefined],
  ["external", "Account/B"],
  ["no-operate", "Account/B"],
  ["missing-project", "Account/B"],
  ["other-environment", "Account/B"],
  ["other-project", "Account/B"],
] as const)(
  "solves a readable external issue with a local project (%s, account=%s)",
  async (guard, connectionId) => {
    const previous = { detail: state.detail, projects: state.projects, allowed: state.allowed };
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("source-environment");
    const projectId = ProjectId.make("lending-project");
    state.allowed = guard !== "no-operate";
    state.writeAllowed = false;
    state.solve.mockClear();
    state.write.mockClear();
    state.candidatesRead.mockClear();
    state.projects =
      guard === "missing-project"
        ? []
        : [
            {
              id: guard === "other-project" ? ProjectId.make("other-project") : projectId,
              environmentId:
                guard === "other-environment"
                  ? EnvironmentId.make("other-environment")
                  : environmentId,
              title: "Lending project",
              workspaceRoot: "/repo",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-14T00:00:00Z",
              updatedAt: "2026-10-14T00:00:00Z",
            },
          ];
    state.detail = {
      ...state.detail,
      projectId,
      connectionId,
      scope: "org/external",
      url: "https://github.com/org/external/issues/1",
      writable: false,
      viewerPermissions: {
        comment: true,
        edit: true,
        labels: true,
        assignees: true,
        setState: true,
      },
      capabilities: {
        ...state.detail.capabilities,
        edit: true,
        states: [
          { category: "open", name: "open" },
          { category: "closed", name: "closed" },
        ],
      },
    };
    const detail = decodeDetail(state.detail);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <IssueDetailPanel
            environmentId={environmentId}
            reference={{
              projectId,
              tracker: IssueTrackerKind.make("github"),
              host: "github.com",
              scope: detail.scope,
              key: detail.key,
              ...(connectionId === undefined ? {} : { connectionId }),
            }}
          />,
        ),
      );
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent?.trim() === "Solve",
      );
      expect(button !== undefined).toBe(guard === "external");
      expect(container.textContent).toContain("Read-only");
      expect(container.querySelector('[aria-label="Edit title"]')).toBeNull();
      expect(container.querySelector('[aria-label="Edit description"]')).toBeNull();
      expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
      expect(
        [...container.querySelectorAll<HTMLButtonElement>("button")].some(
          (node) => node.textContent?.trim() === "Close",
        ),
      ).toBe(false);
      if (button) {
        await act(async () => button.click());
        expect(state.solve).toHaveBeenCalledExactlyOnceWith(detail);
      } else expect(state.solve).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
      expect(state.candidatesRead).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previous.detail;
      state.projects = previous.projects;
      state.allowed = previous.allowed;
      state.writeAllowed = undefined;
      vi.unstubAllGlobals();
    }
  },
);

it("refreshes the issue and its scoped history from the header", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.detailRefresh.mockClear();
  const environmentId = EnvironmentId.make("manual-environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
  const { issueEnvironment } = await import("~/state/issues");
  const signal = issueEnvironment.historyRefresh({ environmentId, input: reference });
  appAtomRegistry.set(signal, 0);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Refresh issue"]')!.click(),
    );
    expect(state.detailRefresh).toHaveBeenCalledOnce();
    expect(appAtomRegistry.get(signal)).toBe(1);
    const other = issueEnvironment.historyRefresh({
      environmentId,
      input: { ...reference, key: "2" },
    });
    expect(appAtomRegistry.get(other)).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["success", "comment-failure", "close-failure", "linear", "no-state-permission", "closed"])(
  "posts before closing with a comment and preserves partial success (%s)",
  async (kind) => {
    const previousDetail = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = true;
    state.toast.mockReset();
    state.candidatesRead.mockReset();
    state.write
      .mockReset()
      .mockImplementation(async ({ input }) =>
        (kind === "comment-failure" && input.body !== undefined) ||
        (kind === "close-failure" && input.state !== undefined)
          ? { _tag: "Failure", cause: Cause.fail(new Error("Native write denied")) }
          : { _tag: "Success" },
      );
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make(kind === "linear" ? "linear" : "github"),
      host: kind === "linear" ? "linear.app" : "github.com",
      scope: "org/repo",
      key: "1",
    };
    const generic = [
      { category: "open" as const, name: "open" },
      { category: "closed" as const, name: "closed" },
    ];
    const states =
      kind === "linear"
        ? [
            { category: "open" as const, name: "Todo", id: "todo" },
            { category: "closed" as const, name: "Done", id: "native-done" },
          ]
        : generic;
    state.detail = {
      ...state.detail,
      ...reference,
      state: kind === "closed" ? generic[1]! : states[0]!,
      states,
      writable: true,
      comments: [],
      commentsCursor: null,
      reactions: undefined,
      viewerPermissions: {
        ...state.detail.viewerPermissions,
        comment: true,
        setState: kind !== "no-state-permission",
      },
      capabilities: {
        ...state.detail.capabilities,
        states: generic,
        closeReasons: ["completed", "not-planned"],
        comment: true,
        events: false,
        linkedPullRequests: false,
      },
    };
    const updated = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <IssueDetailPanel
            environmentId={environmentId}
            reference={reference}
            onUpdated={updated}
          />,
        ),
      );
      const close = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Close with comment",
      );
      if (kind === "no-state-permission" || kind === "closed") {
        expect(close).toBeUndefined();
        expect(state.write).not.toHaveBeenCalled();
        return;
      }
      expect(close).toBeDefined();
      expect(close!.disabled).toBe(true);
      const input = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Add a comment"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          input,
          "Keep this comment",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => close!.click());
      expect(state.write.mock.calls[0]![0]).toEqual({
        environmentId,
        input: { ...reference, body: "Keep this comment" },
      });
      if (kind === "comment-failure") {
        expect(state.write).toHaveBeenCalledOnce();
        expect(input.value).toBe("Keep this comment");
        expect(updated).not.toHaveBeenCalled();
      } else {
        expect(state.write).toHaveBeenCalledTimes(2);
        expect(state.write.mock.calls[1]![0]).toEqual({
          environmentId,
          input: {
            ...reference,
            state: kind === "linear" ? "native-done" : "closed",
            ...(kind === "linear" ? {} : { closeReason: "completed" }),
          },
        });
        expect(input.value).toBe("");
        expect(updated).toHaveBeenCalledOnce();
        if (kind === "close-failure")
          expect(state.toast).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "error",
              title: "The comment was posted, but the issue could not be closed",
            }),
          );
        await act(async () => close!.click());
        expect(state.write).toHaveBeenCalledTimes(2);
      }
      expect(state.candidatesRead).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previousDetail;
      vi.unstubAllGlobals();
    }
  },
);

it.each(["none", "matched", "foreign-repository", "other-environment"])(
  "keeps a Linear linked MR on its supported native destination (%s)",
  async (kind) => {
    const previousDetail = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("linear-workspace"),
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "ENG",
      key: "ENG-1",
    };
    const repository = kind === "foreign-repository" ? "acme/local" : "acme/web";
    state.projects =
      kind === "none"
        ? []
        : [
            {
              environmentId:
                kind === "other-environment" ? EnvironmentId.make("other") : environmentId,
              id: ProjectId.make("gitlab-checkout"),
              title: "GitLab checkout",
              workspaceRoot: "/repo",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-14T00:00:00Z",
              updatedAt: "2026-10-14T00:00:00Z",
              repositoryIdentity: {
                provider: "gitlab",
                canonicalKey: `gitlab.example.com/${repository}`,
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: `https://gitlab.example.com/${repository}.git`,
                },
              },
            },
          ];
    state.detail = {
      ...state.detail,
      ...reference,
      comments: [],
      commentsCursor: null,
      reactions: undefined,
      capabilities: {
        ...state.detail.capabilities,
        states: [],
        linkedPullRequests: true,
        events: false,
      },
    };
    const url = "https://gitlab.example.com/acme/web/-/merge_requests/7";
    const { issueEnvironment } =
      await vi.importActual<typeof import("~/state/issues")>("~/state/issues");
    const page = issueEnvironment.linkedPullRequests({
      environmentId,
      input: reference,
    }) as Atom.Writable<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>;
    appAtomRegistry.set(
      page,
      AsyncResult.success({
        items: [
          {
            provider: SourceControlProviderKind.make("gitlab"),
            host: "gitlab.example.com",
            repository: "acme/web",
            number: 7,
            title: "Linked MR",
            url,
            state: "open",
            isDraft: false,
            closesIssue: false,
          },
        ],
        nextCursor: null,
      }),
    );
    const select = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={appAtomRegistry}>
            <IssueDetailPanel
              environmentId={environmentId}
              reference={reference}
              onSelectPullRequest={select}
            />
          </RegistryContext.Provider>,
        ),
      );
      if (kind === "matched" || kind === "foreign-repository") {
        const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Linked MR"),
        )!;
        await act(async () => row.click());
        expect(select).toHaveBeenCalledExactlyOnceWith({
          projectId: "gitlab-checkout",
          host: "gitlab.example.com",
          repository: "acme/web",
          number: 7,
          url,
        });
      } else {
        expect(container.querySelector(`a[href="${url}"]`)).not.toBeNull();
        expect(select).not.toHaveBeenCalled();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previousDetail;
      state.projects = [];
      vi.unstubAllGlobals();
    }
  },
);

it.each(["viewer-a", null])(
  "clears issue and comment reaction confirmation on viewer switch before ACK (%s)",
  async (viewer) => {
    const previousDetail = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = true;
    state.write.mockReset().mockResolvedValue({ _tag: "Success" });
    const reactions = [
      { content: "thumbs-up" as const, count: 2, actors: [], viewerHasReacted: false },
    ];
    state.detail = {
      ...state.detail,
      viewer,
      reactions,
      writable: true,
      commentsCursor: null,
      comments: [
        {
          id: "comment",
          author: null,
          body: "Native comment",
          createdAt: "2026-10-14T00:00:00Z",
          url: null,
          reactions,
        },
      ],
      capabilities: {
        ...state.detail.capabilities,
        reactions: true,
        events: false,
        linkedPullRequests: false,
      },
    };
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("github"),
      host: "github.com",
      scope: "org/repo",
      key: "1",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const pills = () => [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="thumbs up,"]'),
    ];
    const render = () =>
      act(async () =>
        root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
      );
    try {
      await render();
      expect(pills()).toHaveLength(2);
      for (const pill of pills()) await act(async () => pill.click());
      expect(pills().map((pill) => [pill.textContent, pill.getAttribute("aria-pressed")])).toEqual([
        ["👍3", "true"],
        ["👍3", "true"],
      ]);
      await render();
      expect(pills().every((pill) => pill.getAttribute("aria-pressed") === "true")).toBe(true);
      state.detail = {
        ...state.detail,
        reactions: [...reactions],
        comments: state.detail.comments.map((comment) => ({
          ...comment,
          reactions: [...reactions],
        })),
      };
      await render();
      expect(pills().map((pill) => [pill.textContent, pill.getAttribute("aria-pressed")])).toEqual(
        viewer === null
          ? [
              ["👍2", "false"],
              ["👍2", "false"],
            ]
          : [
              ["👍3", "true"],
              ["👍3", "true"],
            ],
      );
      const native = [{ ...reactions[0]!, count: 3 }];
      state.detail = {
        ...state.detail,
        viewer: "viewer-b",
        reactions: native,
        comments: state.detail.comments.map((comment) => ({ ...comment, reactions: native })),
      };
      await render();
      expect(pills().map((pill) => [pill.textContent, pill.getAttribute("aria-pressed")])).toEqual([
        ["👍3", "false"],
        ["👍3", "false"],
      ]);
      for (const pill of pills()) await act(async () => pill.click());
      expect(
        state.write.mock.calls.map(([request]) => [request.input.subjectId, request.input.reacted]),
      ).toEqual([
        [undefined, true],
        ["comment", true],
        [undefined, true],
        ["comment", true],
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previousDetail;
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  ["Sprint 4", false],
  [null, false],
  [undefined, false],
  [undefined, true],
] as const)(
  "restores unlinked read-only detail metadata and copying (%s, blocked=%s)",
  async (milestone, blockedCopy) => {
    const previousDetail = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writeText = vi.fn();
    if (blockedCopy) writeText.mockRejectedValue(new Error("Clipboard blocked"));
    else writeText.mockResolvedValue(undefined);
    vi.stubGlobal(
      "navigator",
      Object.assign(Object.create(navigator), { clipboard: { writeText } }),
    );
    state.toast.mockReset();
    state.detail = {
      ...state.detail,
      milestone,
      state: { category: "open", name: "Waiting for QA" },
      writable: false,
      comments: [],
      commentsCursor: null,
      capabilities: {
        ...state.detail.capabilities,
        states: [],
        events: false,
        linkedPullRequests: false,
      },
    };
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("github"),
      host: "github.com",
      scope: "org/repo",
      key: "1",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
      );
      expect(container.textContent).toContain("Waiting for QA");
      expect(container.textContent).toContain(
        `updated ${formatRelativeTimeLabel(state.detail.updatedAt)}`,
      );
      expect(container.textContent?.includes("Milestone")).toBe(
        milestone !== null && milestone !== undefined,
      );
      if (milestone) expect(container.textContent).toContain(milestone);
      await act(async () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy issue link"]')!.click(),
      );
      expect(writeText).toHaveBeenCalledExactlyOnceWith(state.detail.url);
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining(
          blockedCopy
            ? { type: "error", title: "The issue link could not be copied" }
            : { type: "success", title: "Issue link copied", description: state.detail.url },
        ),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previousDetail;
      vi.unstubAllGlobals();
    }
  },
);

it("can comment after switching from History to an issue without history support", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockResolvedValue({ _tag: "Success" });
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    const history = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "History",
    );
    expect(history).toBeDefined();
    await act(async () => history!.click());
    expect(container.querySelector("textarea")).toBeNull();
    state.detail = {
      ...state.detail,
      key: "2",
      capabilities: { ...state.detail.capabilities, events: false },
    };
    await act(async () =>
      root.render(
        <IssueDetailPanel environmentId={environmentId} reference={{ ...reference, key: "2" }} />,
      ),
    );
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Add a comment"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "New comment",
      );
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input!
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(state.write).toHaveBeenCalledWith({
      environmentId,
      input: { ...reference, key: "2", body: "New comment" },
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("closes a parent edit draft when the issue identity changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockClear();
  state.detail = {
    ...state.detail,
    key: "1",
    capabilities: {
      ...state.detail.capabilities,
      subIssues: true,
      updateParent: true,
      events: false,
    },
    viewerPermissions: { ...state.detail.viewerPermissions, edit: true },
  };
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    const setParent = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Set parent",
      )!;
    await act(async () => setParent().click());
    expect(container.querySelector('input[aria-label="Parent issue key"]')).not.toBeNull();
    state.detail = { ...state.detail, key: "2" };
    await act(async () =>
      root.render(
        <IssueDetailPanel environmentId={environmentId} reference={{ ...reference, key: "2" }} />,
      ),
    );
    expect(container.querySelector('input[aria-label="Parent issue key"]')).toBeNull();
    await act(async () => setParent().click());
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Parent issue key"]')?.value,
    ).toBe("");
    expect(state.write).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("closes a sub-issue draft instead of moving it to a different parent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockClear();
  state.detail = {
    ...state.detail,
    key: "1",
    capabilities: {
      ...state.detail.capabilities,
      subIssues: true,
      createSubIssue: true,
      events: false,
    },
  };
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    const create = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "New sub-issue",
    )!;
    await act(async () => create.click());
    const title = document.querySelector<HTMLInputElement>("#issue-create-title");
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        title,
        "Child for first parent",
      );
      title!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    state.detail = { ...state.detail, key: "2", displayKey: "#2" };
    await act(async () =>
      root.render(
        <IssueDetailPanel environmentId={environmentId} reference={{ ...reference, key: "2" }} />,
      ),
    );
    expect(document.querySelector("#issue-create-title")).toBeNull();
    expect(state.write).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

describe("native issue state controls", () => {
  const environmentId = EnvironmentId.make("environment");
  let container: HTMLDivElement;
  let root: Root;
  const reference = (tracker: string, connectionId?: string) => ({
    ...(connectionId === undefined ? {} : { connectionId }),
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make(tracker),
    host: "native.example",
    scope: "ENG",
    key: tracker === "jira" ? "ENG-1" : "1",
  });
  const render = (tracker: string, connectionId?: string) =>
    root.render(
      <IssueDetailPanel
        environmentId={environmentId}
        reference={reference(tracker, connectionId)}
      />,
    );
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.write.mockClear().mockResolvedValue({ _tag: "Success" });
    state.candidatesRead.mockReset();
    state.candidates = { data: null, error: null, isPending: false, refresh: vi.fn() };
    state.detail = {
      ...state.detail,
      state: { category: "open", name: "open" },
      states: undefined,
      capabilities: {
        ...state.detail.capabilities,
        subIssues: false,
        createSubIssue: false,
        closeReasons: [],
        states: [
          { category: "open", name: "open" },
          { category: "closed", name: "closed" },
        ],
      },
      viewerPermissions: { ...state.detail.viewerPermissions, setState: true },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it.each(["linear", "azure-devops"])(
    "writes native detail IDs with generic capability states (%s)",
    async (tracker) => {
      state.detail = {
        ...state.detail,
        tracker,
        state: { category: "open", name: "Todo", id: "todo-id" },
        states: [
          { category: "open", name: "Todo", id: "todo-id" },
          { category: "open", name: "In Review", id: "review-id" },
        ],
      };
      await act(async () => render(tracker));
      const review = buttons().find((button) => button.textContent === "In Review");
      expect(review).toBeDefined();
      await act(async () => review!.click());
      expect(state.write).toHaveBeenCalledWith({
        environmentId,
        input: { ...reference(tracker), state: "review-id" },
      });
      expect(state.candidatesRead).not.toHaveBeenCalled();
    },
  );
  it.each([
    "linear-started",
    "linear-completed",
    "linear-canceled",
    "azure-devops",
    "github",
    "gitlab",
  ])("omits the current native state while preserving valid transitions (%s)", async (kind) => {
    const tracker = kind.startsWith("linear") ? "linear" : kind;
    const generic = tracker === "github" || tracker === "gitlab";
    const current: IssueState = generic
      ? { category: "open", name: "open" }
      : kind === "linear-completed"
        ? { category: "closed", name: "Done", id: "done", workflowCategory: "completed" }
        : kind === "linear-canceled"
          ? { category: "closed", name: "Canceled", id: "canceled", workflowCategory: "canceled" }
          : { category: "open", name: "In Progress", id: "started", workflowCategory: "started" };
    const destination: IssueState = generic
      ? { category: "closed", name: "closed" }
      : kind === "linear-completed"
        ? { category: "closed", name: "Canceled", id: "canceled", workflowCategory: "canceled" }
        : kind === "linear-canceled"
          ? { category: "closed", name: "Done", id: "done", workflowCategory: "completed" }
          : { category: "open", name: "In Review", id: "review", workflowCategory: "started" };
    state.detail = {
      ...state.detail,
      tracker,
      writable: true,
      state: current,
      states: generic ? undefined : [current, destination],
      viewerPermissions: { ...state.detail.viewerPermissions, setState: true },
    };
    await act(async () => render(tracker));
    expect(
      buttons().some(
        (button) => button.textContent === "Reopen" || button.textContent === current.name,
      ),
    ).toBe(false);
    const action = buttons().find(
      (button) => button.textContent === (generic ? "Close" : destination.name),
    );
    expect(action).toBeDefined();
    await act(async () => action!.click());
    expect(state.write).toHaveBeenCalledOnce();
    expect(state.write).toHaveBeenCalledWith({
      environmentId,
      input: { ...reference(tracker), state: destination.id ?? destination.name },
    });
    expect(state.candidatesRead).not.toHaveBeenCalled();
  });
  it.each([undefined, "B"])(
    "reads Jira states only on menu open and retries failure without generic writes (%s)",
    async (connectionId) => {
      state.candidates.error = "Project states unavailable";
      state.detail = {
        ...state.detail,
        tracker: "jira",
        connectionId,
        state: { category: "open", name: "Todo", id: "todo-id" },
        states: [{ category: "open", name: "Todo", id: "todo-id" }],
      };
      await act(async () => render("jira", connectionId));
      expect(state.candidatesRead).not.toHaveBeenCalled();
      const trigger = buttons().find((button) => button.textContent?.startsWith("Change state"))!;
      await act(async () =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
      );
      expect(document.body.textContent).toContain("Project states unavailable");
      const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(
        items().some((item) => item.textContent === "Close" || item.textContent === "Reopen"),
      ).toBe(false);
      await act(async () =>
        items()
          .find((item) => item.textContent === "Retry")!
          .click(),
      );
      expect(state.candidates.refresh).toHaveBeenCalledOnce();
      expect(state.write).not.toHaveBeenCalled();
      state.candidates = {
        ...state.candidates,
        error: null,
      };
      const taskStates: ReadonlyArray<IssueState> = [
        state.detail.state,
        { category: "open", name: "In Review", id: "review-id" },
        { category: "closed", name: "Done", id: "done-id" },
      ];
      const verified: IssueState = { category: "closed", name: "Verified", id: "verified-id" };
      state.candidatesRead.mockImplementation(({ input }: { input: unknown }) => {
        const { key, connectionId: account } = decodeCandidatesInput(input);
        expect(account).toBe(connectionId);
        state.candidates.data = {
          states:
            key === "ENG-1"
              ? taskStates
              : key === "ENG-2"
                ? [state.detail.state, verified]
                : [...taskStates, verified],
        };
      });
      await act(async () => render("jira", connectionId));
      expect(items().map((item) => item.textContent)).toEqual(["In Review", "Done"]);
      expect(state.candidatesRead).toHaveBeenCalledWith({
        environmentId,
        input: reference("jira", connectionId),
      });
      await act(async () =>
        items()
          .find((item) => item.textContent === "In Review")!
          .click(),
      );
      expect(state.write).toHaveBeenCalledWith({
        environmentId,
        input: { ...reference("jira", connectionId), state: "review-id" },
      });
      state.candidatesRead.mockClear();
      state.write.mockClear();
      state.detail = { ...state.detail, key: "ENG-2", displayKey: "ENG-2" };
      await act(async () =>
        root.render(
          <IssueDetailPanel
            environmentId={environmentId}
            reference={{ ...reference("jira", connectionId), key: "ENG-2" }}
          />,
        ),
      );
      expect(state.candidatesRead).not.toHaveBeenCalled();
      expect(items()).toHaveLength(0);
      await act(async () =>
        buttons()
          .find((button) => button.textContent?.startsWith("Change state"))!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
      );
      expect(items().map((item) => item.textContent)).toEqual(["Verified"]);
      await act(async () => items()[0]!.click());
      expect(state.write).toHaveBeenCalledWith({
        environmentId,
        input: { ...reference("jira", connectionId), key: "ENG-2", state: "verified-id" },
      });
    },
  );
  it("closes Jira with a comment only after native state retry and a successful post", async () => {
    state.allowed = true;
    state.candidates.error = "Project states unavailable";
    state.detail = {
      ...state.detail,
      tracker: "jira",
      writable: true,
      state: { category: "open", name: "Todo", id: "todo-id" },
      states: [{ category: "open", name: "Todo", id: "todo-id" }],
      capabilities: { ...state.detail.capabilities, comment: true, closeReasons: ["completed"] },
      viewerPermissions: { ...state.detail.viewerPermissions, comment: true, setState: true },
    };
    let finishPost!: (result: { _tag: "Success" }) => void;
    const posted = new Promise<{ _tag: "Success" }>((resolve) => {
      finishPost = resolve;
    });
    state.write
      .mockReset()
      .mockImplementation(async ({ input }) =>
        input.body === undefined ? { _tag: "Success" } : posted,
      );
    await act(async () => render("jira"));
    expect(state.candidatesRead).not.toHaveBeenCalled();
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Add a comment"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "Ready to close",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const trigger = buttons().find((button) => button.textContent === "Close with comment")!;
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.body.textContent).toContain("Project states unavailable");
    expect(state.write).not.toHaveBeenCalled();
    expect(input.value).toBe("Ready to close");
    await act(async () =>
      items()
        .find((item) => item.textContent === "Retry")!
        .click(),
    );
    expect(state.candidates.refresh).toHaveBeenCalledOnce();
    state.candidates = {
      ...state.candidates,
      error: null,
    };
    const taskStates: ReadonlyArray<IssueState> = [
      state.detail.state,
      { category: "closed", name: "Done", id: "10003" },
      { category: "closed", name: "Canceled", id: "10004" },
    ];
    state.candidatesRead.mockImplementation(({ input }: { input: unknown }) => {
      state.candidates.data = {
        states:
          decodeCandidatesInput(input).key === "ENG-1"
            ? taskStates
            : [...taskStates, { category: "closed", name: "Verified", id: "bug-only" }],
      };
    });
    await act(async () => render("jira"));
    expect(items().map((item) => item.textContent)).toEqual(["Done", "Canceled"]);
    expect(state.candidatesRead).toHaveBeenCalledWith({
      environmentId,
      input: reference("jira"),
    });
    await act(async () =>
      items()
        .find((item) => item.textContent === "Done")!
        .click(),
    );
    expect(state.write).toHaveBeenCalledOnce();
    expect(state.write.mock.calls[0]![0]).toEqual({
      environmentId,
      input: { ...reference("jira"), body: "Ready to close" },
    });
    expect(
      buttons().find((button) => button.textContent?.startsWith("Change state"))!.disabled,
    ).toBe(true);
    await act(async () => finishPost({ _tag: "Success" }));
    expect(state.write.mock.calls[1]![0]).toEqual({
      environmentId,
      input: { ...reference("jira"), state: "10003" },
    });
    expect(input.value).toBe("");
  });
  it.each(["linear", "github"])(
    "uses close reasons only for generic closed states (%s)",
    async (tracker) => {
      state.detail = {
        ...state.detail,
        tracker,
        capabilities: {
          ...state.detail.capabilities,
          closeReasons:
            tracker === "linear" ? ["completed", "canceled"] : ["completed", "not_planned"],
        },
      };
      if (tracker === "linear")
        state.detail = {
          ...state.detail,
          state: { category: "open", name: "Todo", id: "todo-id" },
          states: [
            { category: "open", name: "Todo", id: "todo-id" },
            { category: "closed", name: "Done", id: "done-id" },
          ],
        };
      await act(async () => render(tracker));
      const trigger = buttons().find((button) =>
        button.textContent?.startsWith(tracker === "linear" ? "Change state" : "Close"),
      )!;
      await act(async () =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
      );
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent === (tracker === "linear" ? "Done" : "Close as completed"),
      );
      expect(item).toBeDefined();
      await act(async () => item!.click());
      expect(state.write).toHaveBeenCalledWith({
        environmentId,
        input: {
          ...reference(tracker),
          state: tracker === "linear" ? "done-id" : "closed",
          ...(tracker === "github" ? { closeReason: "completed" } : {}),
        },
      });
    },
  );
  it.each(["github", "gitlab"])(
    "keeps generic state writes and capability guards (%s)",
    async (tracker) => {
      state.detail = { ...state.detail, tracker };
      const close = () => buttons().find((button) => button.textContent === "Close");
      await act(async () => render(tracker));
      await act(async () => close()!.click());
      expect(state.write).toHaveBeenCalledWith({
        environmentId,
        input: { ...reference(tracker), state: "closed" },
      });
      state.detail = {
        ...state.detail,
        viewerPermissions: { ...state.detail.viewerPermissions, setState: false },
      };
      await act(async () => render(tracker));
      expect(close()).toBeUndefined();
      state.detail = {
        ...state.detail,
        capabilities: { ...state.detail.capabilities, states: [] },
        viewerPermissions: { ...state.detail.viewerPermissions, setState: true },
      };
      await act(async () => render(tracker));
      expect(close()).toBeUndefined();
      expect(state.candidatesRead).not.toHaveBeenCalled();
      expect(state.write).toHaveBeenCalledOnce();
    },
  );
});

it.each([
  { tracker: "linear", viewer: "viewer-123" },
  { tracker: "jira", viewer: "viewer-123" },
  { tracker: "linear", viewer: null },
])("roundtrips cached viewer context for older comments (%j)", async ({ tracker, viewer }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.commentsRead.mockReset().mockImplementation(async ({ input }) => {
    const wire = encodeCommentPageInput(input);
    const decoded = decodeCommentPageInput(wire);
    const owned = decoded.viewer === "viewer-123";
    expect(decoded.viewer).toBe(state.detail.viewer ?? undefined);
    return {
      comments: [
        {
          id: "older-own-comment",
          author: { id: "viewer-123", login: "me", name: null, avatarUrl: null },
          body: "Older own comment",
          createdAt: "2026-10-01T00:00:00Z",
          url: null,
          canEdit: owned,
          reactions: [{ content: "thumbs-up", count: 1, actors: [], viewerHasReacted: owned }],
        },
      ],
      nextCursor: null,
    };
  });
  state.detail = {
    ...state.detail,
    tracker,
    key: "ENG-1",
    viewer,
    comments: [],
    commentsCursor: "older",
    capabilities: {
      ...state.detail.capabilities,
      editComment: true,
      reactions: tracker === "linear",
      subIssues: false,
      events: false,
    },
  };
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make(tracker),
    host: "native.example",
    scope: "ENG",
    key: "ENG-1",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    expect(state.commentsRead).toHaveBeenCalledOnce();
    expect(state.commentsRead).toHaveBeenCalledWith({
      environmentId,
      input: {
        ...reference,
        cursor: "older",
        order: "desc",
        ...(viewer === null ? {} : { viewer }),
      },
    });
    expect(container.textContent).toContain("Older own comment");
    const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]');
    expect(edit !== null).toBe(viewer !== null);
    if (tracker === "linear")
      expect(
        container.querySelector('button[aria-label^="thumbs up,"]')!.getAttribute("aria-pressed"),
      ).toBe(String(viewer !== null));
    if (edit !== null) {
      await act(async () => edit.click());
      expect(
        container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]')?.value,
      ).toBe("Older own comment");
    }
    state.detail = { ...state.detail };
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    expect(state.commentsRead).toHaveBeenCalledOnce();
    if (viewer !== null) {
      const read = state.commentsRead.getMockImplementation()!;
      let finish!: (page: IssueCommentsPage) => void;
      state.commentsRead.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      state.detail = { ...state.detail, viewer: "viewer-456" };
      await act(async () =>
        root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
      );
      expect(container.querySelector('textarea[aria-label="Edit comment"]')).toBeNull();
      expect(container.querySelector('button[aria-label^="thumbs up,"]')).toBeNull();
      expect(state.commentsRead).toHaveBeenCalledTimes(2);
      expect((state.commentsRead.mock.calls[1]![0].input as { viewer: string }).viewer).toBe(
        "viewer-456",
      );
      await act(async () => finish(await read(state.commentsRead.mock.calls[1]![0])));
      expect(container.querySelector('button[aria-label="Edit comment"]')).toBeNull();
      if (tracker === "linear")
        expect(
          container.querySelector('button[aria-label^="thumbs up,"]')!.getAttribute("aria-pressed"),
        ).toBe("false");
    } else expect(container.textContent).toContain("Older own comment");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    appAtomRegistry.reset();
    state.commentsRead.mockReset().mockResolvedValue({ comments: [], nextCursor: null });
    vi.unstubAllGlobals();
  }
});

it.each(["unknown", "allowed", "denied", "unsupported", "no-grant", "read-only"])(
  "keeps Azure comment editing behind native and client guards (%s)",
  async (guard) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = guard !== "no-grant";
    state.toast.mockReset();
    state.write.mockReset().mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Azure 403 Forbidden")),
    });
    state.detail = {
      ...state.detail,
      tracker: "azure-devops",
      viewer: null,
      key: "42",
      comments: [
        {
          id: "comment",
          author: null,
          body: "Original comment",
          createdAt: "2026-10-14T00:00:00Z",
          url: null,
          ...(guard === "unknown" ? {} : { canEdit: guard !== "denied" }),
        },
      ],
      commentsCursor: null,
      writable: guard !== "read-only",
      capabilities: {
        ...state.detail.capabilities,
        editComment: guard !== "unsupported",
        reactions: false,
        events: false,
      },
    };
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("azure-devops"),
      host: "dev.azure.com",
      scope: "org/project",
      key: "42",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
      );
      const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]');
      expect(edit !== null).toBe(guard === "unknown" || guard === "allowed");
      if (guard === "unknown") {
        await act(async () => edit!.click());
        const input = container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Edit comment"]',
        )!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
            input,
            "Keep this draft",
          );
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Save",
        )!;
        await act(async () => save.click());
        expect(state.write).toHaveBeenCalledExactlyOnceWith({
          environmentId,
          input: { ...reference, commentId: "comment", body: "Keep this draft" },
        });
        expect(state.toast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not save the comment",
            description: "Azure 403 Forbidden",
          }),
        );
        expect(
          container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]')
            ?.value,
        ).toBe("Keep this draft");
        expect(save.disabled).toBe(false);
      } else expect(state.write).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.allowed = true;
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  { tracker: "github", cursor: "related:" },
  { tracker: "gitlab", cursor: "related:1" },
])(
  "loads related pull requests after an empty closing page ($tracker)",
  async ({ tracker, cursor }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("environment");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make(tracker),
      host: `${tracker}.com`,
      scope: "org/repo",
      key: "1",
    };
    state.detail = {
      ...state.detail,
      ...reference,
      comments: [],
      commentsCursor: null,
      capabilities: { ...state.detail.capabilities, linkedPullRequests: true, subIssues: false },
    };
    const { issueEnvironment } =
      await vi.importActual<typeof import("~/state/issues")>("~/state/issues");
    const first = issueEnvironment.linkedPullRequests({
      environmentId,
      input: reference,
    }) as Atom.Writable<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>;
    const next = issueEnvironment.linkedPullRequests({
      environmentId,
      input: { ...reference, cursor },
    }) as Atom.Writable<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>;
    appAtomRegistry.set(first, AsyncResult.success({ items: [], nextCursor: cursor }));
    const url = `https://${tracker}.com/org/repo/pull/2`;
    appAtomRegistry.set(
      next,
      AsyncResult.success({
        items: [
          {
            repository: "org/repo",
            number: 2,
            title: "Related change",
            url,
            state: "open",
            isDraft: false,
            closesIssue: false,
          },
        ],
        nextCursor: null,
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={appAtomRegistry}>
            <IssueDetailPanel environmentId={environmentId} reference={reference} />
          </RegistryContext.Provider>,
        ),
      );
      expect(container.textContent).toContain("Related change");
      expect(container.querySelector(`a[href="${url}"]`)).not.toBeNull();
      expect(container.textContent).not.toContain("Load more pull requests");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = {
        ...state.detail,
        capabilities: { ...state.detail.capabilities, linkedPullRequests: false },
      };
      vi.unstubAllGlobals();
    }
  },
);

describe("native issue body editability", () => {
  const environmentId = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("jira"),
    host: "acme.atlassian.net",
    scope: "ENG",
    key: "ENG-1",
  };
  let container: HTMLDivElement;
  let root: Root;
  const render = () =>
    root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />);
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.getAttribute("aria-label") === label || element.textContent === label,
    );
  const description = () =>
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]');
  const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = true;
    state.write.mockReset().mockResolvedValue({ _tag: "Success" });
    state.detail = {
      ...state.detail,
      ...reference,
      body: "Original body",
      bodyEditable: undefined,
      url: "https://acme.atlassian.net/browse/ENG-1",
      comments: [],
      events: [],
      reactions: undefined,
      writable: true,
      viewerPermissions: { ...state.detail.viewerPermissions, edit: true },
      capabilities: {
        ...state.detail.capabilities,
        edit: true,
        comment: false,
        events: false,
        reactions: false,
        linkedPullRequests: false,
        subIssues: false,
        labels: false,
        assignees: false,
        states: [],
      },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it.each(["body", "title"])(
    "drops the previous account's %s editor on an equal native issue and viewer",
    async (field) => {
      state.detail = { ...state.detail, connectionId: "A", viewer: "same-viewer" };
      await act(async () =>
        root.render(
          <IssueDetailPanel
            environmentId={environmentId}
            reference={{ ...reference, connectionId: "A" }}
          />,
        ),
      );
      await act(async () => button(field === "body" ? "Edit description" : "Edit title")!.click());
      const editor = () =>
        field === "body"
          ? description()
          : container.querySelector<HTMLInputElement>('input[aria-label="Issue title"]');
      await act(async () => type(editor()!, "Private A draft"));
      state.detail = {
        ...state.detail,
        connectionId: "B",
        body: "Native B body",
        title: "Native B title",
      };
      await act(async () =>
        root.render(
          <IssueDetailPanel
            environmentId={environmentId}
            reference={{ ...reference, connectionId: "B" }}
          />,
        ),
      );
      expect(editor()).toBeNull();
      expect(container.textContent).not.toContain("Private A draft");
      expect(state.write).not.toHaveBeenCalled();
      await act(async () => button(field === "body" ? "Edit description" : "Edit title")!.click());
      await act(async () => type(editor()!, "B change"));
      await act(async () => button("Save")!.click());
      expect(state.write).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { ...reference, connectionId: "B", [field]: "B change" },
      });
    },
  );
  it("cancels a title edit with Escape without leaving the issues page", async () => {
    function IssuesPage() {
      useEscapeToGoBack();
      return <IssueDetailPanel environmentId={environmentId} reference={reference} />;
    }
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    state.navigate.mockClear();
    try {
      await act(async () => root.render(<IssuesPage />));
      await act(async () => button("Edit title")!.click());
      const title = container.querySelector<HTMLInputElement>('input[aria-label="Issue title"]')!;
      await act(async () =>
        title.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      expect(container.querySelector('input[aria-label="Issue title"]')).toBeNull();
      expect(back).not.toHaveBeenCalled();
      expect(state.navigate).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
      await act(async () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      expect(back).toHaveBeenCalledOnce();
    } finally {
      back.mockRestore();
    }
  });
  it("keeps a typed comment on Escape and still posts with Control+Enter", async () => {
    state.detail = {
      ...state.detail,
      capabilities: { ...state.detail.capabilities, comment: true },
      viewerPermissions: { ...state.detail.viewerPermissions, comment: true },
    };
    function IssuesPage() {
      useEscapeToGoBack();
      return <IssueDetailPanel environmentId={environmentId} reference={reference} />;
    }
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    try {
      await act(async () => root.render(<IssuesPage />));
      const box = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Add a comment"]',
      )!;
      await act(async () => {
        box.focus();
        type(box, "Half a reply");
      });
      const press = (init: KeyboardEventInit) =>
        act(async () => {
          box.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
          );
        });
      await press({ key: "Escape" });
      expect(box.value).toBe("Half a reply");
      expect(document.activeElement).not.toBe(box);
      expect(back).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
      await press({ key: "Enter", ctrlKey: true, isComposing: true });
      await press({ key: "Enter", ctrlKey: true, keyCode: 229 });
      expect(box.value).toBe("Half a reply");
      expect(state.write).not.toHaveBeenCalled();
      await press({ key: "Enter", ctrlKey: true });
      expect(state.write).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { ...reference, body: "Half a reply" },
      });
      expect(box.value).toBe("");
      await press({ key: "Escape" });
      expect(back).toHaveBeenCalledOnce();
    } finally {
      back.mockRestore();
    }
  });
  it("keeps rich descriptions native while saving only the title", async () => {
    state.detail.bodyEditable = false;
    await act(async () => render());
    expect(button("Edit description")).toBeUndefined();
    expect(description()).toBeNull();
    expect(container.textContent).toContain("Original body");
    expect(container.querySelector('a[aria-label="Open on Jira"]')?.getAttribute("href")).toBe(
      state.detail.url,
    );
    await act(async () => button("Edit title")!.click());
    await act(async () =>
      type(
        container.querySelector<HTMLInputElement>('input[aria-label="Issue title"]')!,
        "Renamed",
      ),
    );
    await act(async () => button("Save")!.click());
    expect(state.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { ...reference, title: "Renamed" },
    });
  });
  it.each([undefined, true])("edits the body when bodyEditable is %s", async (bodyEditable) => {
    state.detail.bodyEditable = bodyEditable;
    await act(async () => render());
    await act(async () => button("Edit description")!.click());
    await act(async () => type(description()!, "Updated body"));
    await act(async () => button("Save")!.click());
    expect(state.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { ...reference, body: "Updated body" },
    });
    expect(description()).toBeNull();
  });
  it("removes an active body editor when the native body becomes read-only", async () => {
    state.detail.bodyEditable = true;
    await act(async () => render());
    await act(async () => button("Edit description")!.click());
    await act(async () => type(description()!, "Local draft"));
    state.detail = { ...state.detail, bodyEditable: false };
    await act(async () => render());
    expect(description()).toBeNull();
    expect(button("Edit description")).toBeUndefined();
    expect(button("Edit title")).toBeDefined();
    expect(container.textContent).toContain("Original body");
    expect(state.write).not.toHaveBeenCalled();
  });
  it("keeps a refused body draft for retry", async () => {
    state.write
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("")) })
      .mockResolvedValueOnce({ _tag: "Success" });
    state.toast.mockReset();
    await act(async () => render());
    await act(async () => button("Edit description")!.click());
    await act(async () => type(description()!, "Retry body"));
    await act(async () => button("Save")!.click());
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "The issue could not be updated",
      description: "The tracker refused it.",
    });
    expect(description()?.value).toBe("Retry body");
    await act(async () => button("Save")!.click());
    expect(state.write.mock.calls.map(([target]) => target.input.body)).toEqual([
      "Retry body",
      "Retry body",
    ]);
    expect(description()).toBeNull();
  });
  it.each(["viewer", "environment"])(
    "keeps native body restrictions after a %s switch",
    async (scope) => {
      state.detail = { ...state.detail, viewer: "viewer-a", bodyEditable: true };
      await act(async () => render());
      await act(async () => button("Edit description")!.click());
      await act(async () => type(description()!, "Previous scope draft"));
      state.detail = {
        ...state.detail,
        viewer: "viewer-b",
        body: "Current native body",
        bodyEditable: false,
      };
      const currentEnvironmentId =
        scope === "environment" ? EnvironmentId.make("other-environment") : environmentId;
      await act(async () =>
        root.render(
          <IssueDetailPanel environmentId={currentEnvironmentId} reference={reference} />,
        ),
      );
      expect(description()).toBeNull();
      expect(button("Edit description")).toBeUndefined();
      expect(container.textContent).toContain("Current native body");
      expect(container.textContent).not.toContain("Previous scope draft");
      expect(state.write).not.toHaveBeenCalled();
      await act(async () => button("Edit title")!.click());
      await act(async () =>
        type(
          container.querySelector<HTMLInputElement>('input[aria-label="Issue title"]')!,
          "Current title",
        ),
      );
      await act(async () => button("Save")!.click());
      expect(state.write).toHaveBeenCalledExactlyOnceWith({
        environmentId: currentEnvironmentId,
        input: { ...reference, title: "Current title" },
      });
    },
  );
});

it.each(["retry", "cancel", "permission", "state-only"])(
  "collects native state fields before a comment and preserves the result (%s)",
  async (kind) => {
    const previous = state.detail;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.write.mockReset().mockResolvedValue({ _tag: "Success" });
    state.allowed = true;
    const environmentId = EnvironmentId.make("native-state");
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("jira"),
      host: "tracker.example/Jira",
      scope: "ENG",
      key: "ENG-1",
      connectionId: "Account-B",
    };
    const open: IssueState = { id: "open-status", name: "Todo", category: "open" };
    const closed: IssueState = {
      id: "done-status",
      transitionId: "native-transition",
      name: "Done",
      category: "closed",
      fields: [{ id: "resolution", label: "Resolution", kind: "text", required: true }],
    };
    state.detail = {
      ...state.detail,
      ...reference,
      state: open,
      states: [open, closed],
      writable: true,
      viewerPermissions: { ...state.detail.viewerPermissions, comment: true, setState: true },
      capabilities: {
        ...state.detail.capabilities,
        states: [open, closed],
        closeReasons: [],
        comment: true,
        events: false,
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = () =>
      act(async () =>
        root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
      );
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent === text,
      )!;
    try {
      await render();
      const commentInput = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Add a comment"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          commentInput,
          "Only post once",
        );
        commentInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => button(kind === "state-only" ? "Done" : "Close with comment").click());
      expect(state.write).not.toHaveBeenCalled();
      expect(button("Change state").disabled).toBe(true);
      if (kind === "cancel") {
        await act(async () => button("Cancel").click());
        expect(commentInput.value).toBe("Only post once");
        expect(state.write).not.toHaveBeenCalled();
        return;
      }
      const field = document.querySelector<HTMLInputElement>("#issue-native-field-resolution")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          "Fixed",
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      if (kind === "permission") {
        state.detail = {
          ...state.detail,
          viewerPermissions: { ...state.detail.viewerPermissions, setState: false },
        };
        await render();
        expect(button("Change state").disabled).toBe(true);
        await act(async () => button("Change state").click());
        expect(state.write).not.toHaveBeenCalled();
        return;
      }
      if (kind === "state-only") {
        state.write.mockResolvedValueOnce({
          _tag: "Failure",
          cause: Cause.fail(new Error("Native field rejected")),
        });
        await act(async () => button("Change state").click());
        expect(field.value).toBe("Fixed");
        expect(commentInput.value).toBe("Only post once");
        await act(async () => button("Change state").click());
        expect(state.write.mock.calls.map(([request]) => request.input)).toEqual([
          {
            ...reference,
            state: "done-status",
            transitionId: "native-transition",
            fieldValues: { resolution: "Fixed" },
          },
          {
            ...reference,
            state: "done-status",
            transitionId: "native-transition",
            fieldValues: { resolution: "Fixed" },
          },
        ]);
        return;
      }
      state.write.mockResolvedValueOnce({ _tag: "Success" }).mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("Native field rejected")),
      });
      await act(async () => button("Change state").click());
      expect(state.write.mock.calls.map(([request]) => request.input)).toEqual([
        { ...reference, body: "Only post once" },
        {
          ...reference,
          state: "done-status",
          transitionId: "native-transition",
          fieldValues: { resolution: "Fixed" },
        },
      ]);
      expect(commentInput.value).toBe("");
      expect(field.value).toBe("Fixed");
      expect(document.body.textContent).toContain(
        "The comment was posted. Retry to change the state.",
      );
      await act(async () => button("Change state").click());
      expect(state.write).toHaveBeenCalledTimes(3);
      expect(state.write.mock.calls[2]![0].input).toEqual({
        ...reference,
        state: "done-status",
        transitionId: "native-transition",
        fieldValues: { resolution: "Fixed" },
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.detail = previous;
      vi.unstubAllGlobals();
    }
  },
);

it("edits native ADF when the markdown body is read-only and clears edits for another account", async () => {
  const previous = state.detail;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockReset().mockResolvedValue({ _tag: "Success" });
  state.allowed = true;
  const environmentId = EnvironmentId.make("native-editor");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("jira"),
    host: "tracker.example/Jira",
    scope: "ENG",
    key: "ENG-1",
    connectionId: "Account-A",
  };
  const native = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Account A native text" }] },
      {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [
          { type: "media", attrs: { id: "opaque-media-id", type: "file", collection: "keep" } },
        ],
      },
    ],
  };
  const richBody = { format: "adf" as const, document: JSON.stringify(native) };
  const nativeDetail = {
    ...state.detail,
    ...reference,
    body: "Markdown fallback",
    richBody,
    bodyEditable: false,
    capabilities: { ...state.detail.capabilities, richText: true, edit: true },
    viewerPermissions: { ...state.detail.viewerPermissions, edit: true },
  };
  state.detail = nativeDetail;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === text,
    )!;
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    expect(container.querySelector('[role="textbox"][aria-label="Description"]')).not.toBeNull();
    await act(async () => button("Heading 2").click());
    await act(async () => button("Cancel").click());
    expect(state.write).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    expect(container.querySelector('[role="textbox"] h2')).toBeNull();
    await act(async () => button("Heading 3").click());
    await act(async () => button("Save").click());
    expect(state.write).toHaveBeenCalledOnce();
    const request = state.write.mock.calls[0]![0];
    expect(request.input).toMatchObject({ ...reference, richBody: { format: "adf" } });
    expect(request.input.body).toBeUndefined();
    const saved = JSON.parse(request.input.richBody.document);
    expect(saved.content[0].type).toBe("heading");
    expect(saved.content[1]).toEqual(native.content[1]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    await act(async () => button("Heading 2").click());
    const nextRef = { ...reference, connectionId: "Account-B" };
    state.detail = {
      ...nativeDetail,
      ...nextRef,
      richBody: {
        ...richBody,
        document: JSON.stringify({
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Account B native text" }] },
          ],
        }),
      },
    };
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={nextRef} />),
    );
    expect(container.querySelector('[role="textbox"][aria-label="Description"]')).toBeNull();
    expect(container.textContent).toContain("Account B native text");
    expect(container.textContent).not.toContain("Account A native text");
    expect(state.write).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.detail = previous;
    vi.unstubAllGlobals();
  }
});

it("saves native comment edits, retains failed edits, and blocks a revoked permission", async () => {
  const previous = state.detail;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.write.mockReset().mockResolvedValue({ _tag: "Success" });
  const environmentId = EnvironmentId.make("native-comment");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("jira"),
    host: "tracker.example/Jira",
    scope: "ENG",
    key: "ENG-1",
    connectionId: "Account-B",
  };
  const native = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Native comment",
            marks: [{ type: "textColor", attrs: { color: "#123456" } }],
          },
          { type: "mention", attrs: { id: "opaque-account", text: "Somebody" } },
        ],
      },
    ],
  };
  const richBody = { format: "adf" as const, document: JSON.stringify(native) };
  const nativeDetail = {
    ...state.detail,
    ...reference,
    comments: [
      {
        id: "native-comment-id",
        author: null,
        body: "Plain fallback",
        richBody,
        createdAt: "2026-10-14T00:00:00Z",
        url: null,
        canEdit: true,
      },
    ],
    capabilities: { ...state.detail.capabilities, richText: true, editComment: true },
  };
  state.detail = nativeDetail;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === text,
    )!;
  const render = () =>
    act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
  try {
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!.click(),
    );
    await act(async () => button("Heading 3").click());
    state.write.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Native edit refused")),
    });
    await act(async () => button("Save").click());
    expect(container.querySelector('[role="textbox"] h3')?.textContent).toContain("Native comment");
    await act(async () => button("Save").click());
    const request = state.write.mock.calls[1]![0];
    expect(request.input).toMatchObject({
      ...reference,
      commentId: "native-comment-id",
      body: "Plain fallback",
    });
    const next = JSON.parse(request.input.richBody.document);
    expect(next.content[0].type).toBe("heading");
    expect(next.content[0].content).toEqual(native.content[0]!.content);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!.click(),
    );
    state.detail = {
      ...nativeDetail,
      comments: [{ ...nativeDetail.comments[0]!, canEdit: false }],
    };
    await render();
    expect(button("Save").disabled).toBe(true);
    await act(async () => button("Save").click());
    expect(state.write).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.detail = previous;
    vi.unstubAllGlobals();
  }
});

it("edits DC wiki descriptions and comments as exact source and resets drafts for another account", async () => {
  const previous = state.detail;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.write.mockReset().mockResolvedValue({ _tag: "Success" });
  const environmentId = EnvironmentId.make("wiki-edit");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("jira"),
    host: "tracker.example/Jira",
    scope: "ENG",
    key: "ENG-1",
    connectionId: "Account-A",
  };
  const source = "  h2. Native description\n!media-id! [Link|https://example.test]  \n";
  const commentSource = " *native wiki comment*\n!comment-media! \n";
  const wikiDetail = {
    ...state.detail,
    ...reference,
    body: "Converted fallback must not render",
    bodyEditable: false,
    richBody: { format: "jira-wiki" as const, document: source },
    comments: [
      {
        id: "wiki-comment",
        author: null,
        body: "Comment fallback",
        richBody: { format: "jira-wiki" as const, document: commentSource },
        createdAt: "2026-10-14T00:00:00Z",
        url: null,
        canEdit: true,
      },
    ],
    capabilities: { ...state.detail.capabilities, richText: true, edit: true, editComment: true },
    viewerPermissions: { ...state.detail.viewerPermissions, edit: true },
  };
  state.detail = wikiDetail;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === text,
    )!;
  const type = async (label: string, value: string) =>
    act(async () => {
      const textarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="' + label + ' · Jira wiki markup"]',
      )!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        value,
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
    );
    expect(container.textContent).toContain(source);
    expect(container.textContent).toContain(commentSource);
    expect(container.textContent).not.toContain("Converted fallback must not render");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    await type("Description", "  Cancel this wiki draft  \n");
    await act(async () => button("Cancel").click());
    expect(state.write).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Description · Jira wiki markup"]',
      )?.value,
    ).toBe(source);
    const changed = "  h2. Changed wiki\n!media-id|width=40!  \n";
    await type("Description", changed);
    await act(async () => button("Save").click());
    expect(state.write.mock.calls[0]![0].input).toEqual({
      ...reference,
      richBody: { format: "jira-wiki", document: changed },
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!.click(),
    );
    const changedComment = "  *Changed comment*\n!comment-media!  \n";
    await type("Edit comment", changedComment);
    await act(async () => button("Save").click());
    expect(state.write.mock.calls[1]![0].input).toEqual({
      ...reference,
      commentId: "wiki-comment",
      body: "Comment fallback",
      richBody: { format: "jira-wiki", document: changedComment },
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!.click(),
    );
    await type("Edit comment", "Account A unsaved draft");
    const nextRef = { ...reference, connectionId: "Account-B" };
    state.detail = {
      ...wikiDetail,
      ...nextRef,
      richBody: { format: "jira-wiki", document: " Account B source \n" },
      comments: [],
    };
    await act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={nextRef} />),
    );
    expect(container.textContent).toContain(" Account B source \n");
    expect(container.textContent).not.toContain("Account A unsaved draft");
    expect(container.querySelector('textarea[aria-label$="Jira wiki markup"]')).toBeNull();
    expect(state.write).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.detail = previous;
    vi.unstubAllGlobals();
  }
});

it("edits Azure HTML descriptions and comments as exact source and fails closed elsewhere", async () => {
  const previous = state.detail;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.toast.mockReset();
  state.write.mockReset();
  const environmentId = EnvironmentId.make("azure-html-edit");
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("azure-devops"),
    host: "dev.azure.com",
    scope: "acme/Web",
    key: "7",
    connectionId: "Account-A",
  };
  const source = '<table>\r\n<tr><td><img src="a.png"></td></tr>\r\n</table>\r\n';
  const commentSource = "<p>Native <b>comment</b></p>\r\n";
  const htmlDetail = {
    ...state.detail,
    ...reference,
    body: "Markdown fallback must not render",
    bodyEditable: false,
    richBody: { format: "azure-html" as const, document: source },
    comments: [
      {
        id: "html-comment",
        author: null,
        body: "Comment fallback",
        richBody: { format: "azure-html" as const, document: commentSource },
        createdAt: "2026-10-14T00:00:00Z",
        url: null,
        canEdit: true,
      },
    ],
    capabilities: { ...state.detail.capabilities, richText: true, edit: true, editComment: true },
    viewerPermissions: { ...state.detail.viewerPermissions, edit: true },
  };
  state.detail = htmlDetail;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === text,
    )!;
  const textarea = (label: string) =>
    container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="' + label + ' · HTML source"]',
    );
  const type = async (label: string, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea(label)!,
        value,
      );
      textarea(label)!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const show = (ref = reference) =>
    act(async () =>
      root.render(<IssueDetailPanel environmentId={environmentId} reference={ref} />),
    );
  try {
    await show();
    expect(container.textContent).toContain(source);
    expect(container.textContent).toContain(commentSource);
    expect(container.textContent).not.toContain("Markdown fallback must not render");
    expect(container.querySelector("table, img, b")).toBeNull();
    expect(container.textContent).toContain("HTML source");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    let finish!: (value: unknown) => void;
    state.write.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await act(async () => button("Save").click());
    expect(state.write.mock.calls[0]![0].input).toEqual({
      ...reference,
      richBody: { format: "azure-html", document: source },
    });
    expect(textarea("Description")!.disabled).toBe(true);
    expect(button("Saving…").disabled).toBe(true);
    await act(async () =>
      finish({ _tag: "Failure", cause: Cause.fail(new Error("Azure 412 Precondition")) }),
    );
    expect(state.toast).toHaveBeenCalledOnce();
    expect(textarea("Description")!.disabled).toBe(false);
    await type("Description", textarea("Description")!.value + "<p>Draft</p>");
    await act(async () => button("Cancel").click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    expect(textarea("Description")!.value).toBe(source.replace(/\r\n/g, "\n"));
    await act(async () => button("Cancel").click());
    state.write.mockResolvedValue({ _tag: "Success" });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!.click(),
    );
    await type("Edit comment", "<p>Native <b>edited</b></p>\n");
    await act(async () => button("Save").click());
    expect(state.write.mock.calls[1]![0].input).toEqual({
      ...reference,
      commentId: "html-comment",
      body: "Comment fallback",
      richBody: { format: "azure-html", document: "<p>Native <b>edited</b></p>\r\n" },
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    await type("Description", "Account A unsaved draft");
    const nextRef = { ...reference, connectionId: "Account-B" };
    state.detail = {
      ...htmlDetail,
      ...nextRef,
      richBody: { format: "azure-html", document: "" },
      comments: [],
    };
    await show(nextRef);
    expect(container.textContent).not.toContain("Account A unsaved draft");
    expect(textarea("Description")).toBeNull();
    for (const richBody of [
      undefined,
      { format: "html", document: "<p>Unknown</p>" } as unknown as IssueRichBody,
    ]) {
      state.detail = { ...htmlDetail, richBody, comments: [] };
      await show({ ...reference, key: String(richBody?.format) });
      expect(container.querySelector('[aria-label="Edit description"]')).toBeNull();
      expect(container.textContent).not.toContain("<p>Unknown</p>");
    }
    state.writeAllowed = false;
    state.detail = { ...htmlDetail, comments: [] };
    await show({ ...reference, key: "denied" });
    expect(container.querySelector('[aria-label="Edit description"]')).toBeNull();
    expect(state.write).toHaveBeenCalledTimes(2);
  } finally {
    state.writeAllowed = undefined;
    await act(async () => root.unmount());
    container.remove();
    state.detail = previous;
    vi.unstubAllGlobals();
  }
});
