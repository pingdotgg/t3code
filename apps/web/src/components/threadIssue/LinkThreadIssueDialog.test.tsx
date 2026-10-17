// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  IssueListResult,
  ThreadId,
  WS_METHODS,
  WsIssuesRpcGroup,
  type IssueListCursors,
} from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AsyncResult } from "effect/reactivity";
import { parseIssueUrl } from "@t3tools/shared/issueUrl";

const state = vi.hoisted(() => {
  const source = {
    projectId: "project",
    tracker: "github",
    host: "github.com",
    scope: "org/repo",
    projectTitle: "Project",
    capabilities: {
      create: false,
      edit: false,
      comment: false,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
  };
  const linked = {
    ...source,
    key: "1",
    displayKey: "#1",
    title: "Already linked",
    url: "https://github.com/org/repo/issues/1",
    state: { category: "open", name: "open" },
    author: null,
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    closedAt: null,
    labels: [],
    assignees: [],
    commentCount: 0,
  };
  return {
    source,
    linked,
    list: {
      entries: [linked],
      viewers: {} as Record<string, string>,
      trackers: [],
      sources: [source],
      nextCursors: { "github.com org/repo": "next" } as IssueListCursors,
      errors: [],
    },
    load: vi.fn(),
    link: vi.fn(),
    read: vi.fn(),
    resolve: vi.fn(),
  };
});
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ projectId: "project", issues: [state.linked] }),
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/issues", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const queries = Atom.family((answer: typeof state.list) =>
    Atom.make(AsyncResult.success(answer)).pipe(Atom.keepAlive),
  );
  return {
    issueEnvironment: {
      list: () => queries(state.list),
      detail: () => null,
      listPage: "page",
      resolveUrl: "resolve",
    },
  };
});
vi.mock("~/state/threads", () => ({ threadEnvironment: { linkIssue: "link" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "page" ? state.load : command === "resolve" ? state.resolve : state.link,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: () => state.read(),
}));
vi.mock("~/state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/query")>()),
  formatEnvironmentQueryError: () => "failed",
}));

import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { issueEnvironment } from "~/state/issues";
import { LinkThreadIssueDialogHost, openLinkThreadIssueDialog } from "./LinkThreadIssueDialog";

const decodeIssueList = Schema.decodeUnknownSync(IssueListResult);

it("blocks a removed account and keeps drafts for explicitly choosing its replacement", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const original = state.list;
  const a = { ...state.source, connectionId: "A" };
  const b = { ...a, connectionId: "B" };
  const rowA = {
    ...state.linked,
    ...a,
    key: "42",
    url: "https://github.com/org/repo/issues/42",
    title: "A issue",
  };
  const rowB = { ...rowA, ...b, title: "B issue" };
  state.list = { ...original, sources: [a, b], entries: [rowA, rowB], nextCursors: {} };
  const query = Atom.make(AsyncResult.success(decodeIssueList(state.list))).pipe(Atom.keepAlive);
  const list = vi.spyOn(issueEnvironment, "list").mockReturnValue(query);
  state.read.mockReset().mockResolvedValue({ _tag: "Success", value: rowB });
  state.link.mockReset().mockResolvedValue({ _tag: "Failure" });
  state.resolve.mockReset();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    root.render(
      createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
    );
  try {
    openLinkThreadIssueDialog({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    });
    await act(async () => render());
    expect(document.body.textContent).toContain("A issue");
    expect(document.body.textContent).not.toContain("B issue");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Issue source"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    const account = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.endsWith(" · B"),
    )!;
    await act(async () => account.click());
    expect(document.body.textContent).toContain("B issue");
    expect(document.body.textContent).not.toContain("A issue");
    const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("B issue"),
    )!;
    await act(async () => row.click());
    expect(state.link).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      input: expect.objectContaining({ connectionId: "B", key: "42" }),
    });
    expect(state.read).not.toHaveBeenCalled();
    for (const [label, value] of [
      ["Issue URL", rowB.url],
      ["Search issues", "draft query"],
      ["Issue scope", "org/repo"],
      ["Issue key", "42"],
    ]) {
      const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    state.list = { ...state.list, sources: [a], entries: [rowA] };
    await act(async () =>
      appAtomRegistry.set(query, AsyncResult.success(decodeIssueList(state.list))),
    );
    expect(document.querySelector('[aria-label="Issue key"]')).toBeNull();
    expect(document.querySelector('[aria-label="Issue source"]')).not.toBeNull();
    const url = document.querySelector<HTMLInputElement>('[aria-label="Issue URL"]')!;
    expect(url.value).toBe(rowB.url);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Search issues"]')?.disabled).toBe(
      true,
    );
    await act(async () =>
      url.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.link).toHaveBeenCalledOnce();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Issue source"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const replacement = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.endsWith(" · A"),
    )!;
    await act(async () => replacement.click());
    for (const [label, value] of [
      ["Issue URL", rowB.url],
      ["Search issues", "draft query"],
      ["Issue scope", "org/repo"],
      ["Issue key", "42"],
    ])
      expect(document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)?.value).toBe(
        value,
      );
    state.read.mockResolvedValue({ _tag: "Success", value: rowA });
    state.link.mockResolvedValueOnce({ _tag: "Success" });
    await act(async () => {
      document
        .querySelector<HTMLInputElement>('[aria-label="Issue key"]')!
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(state.read).toHaveBeenCalledOnce();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.link).toHaveBeenCalledTimes(2);
    expect(state.link).toHaveBeenLastCalledWith({
      environmentId: "environment",
      input: expect.objectContaining({ connectionId: "A", key: "42", url: rowA.url }),
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.list = original;
    list.mockRestore();
    vi.unstubAllGlobals();
  }
});
const RpcClient = await vi.importActual<typeof import("@t3tools/client-runtime/rpc")>(
  "../../../../../packages/client-runtime/src/rpc/client.ts",
);

it.each([
  { viewer: "B", empty: false, legacy: false, failFirst: false },
  { viewer: "B", empty: true, legacy: false, failFirst: false },
  { viewer: "A", empty: false, legacy: false, failFirst: false },
  { viewer: "B", empty: false, legacy: true, failFirst: false },
  { viewer: "B", empty: false, legacy: false, failFirst: true },
])(
  "restarts the native account's first query once without restoring seeds: %j",
  async ({ viewer, empty, legacy, failFirst }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const atoms = createIssueEnvironmentAtoms(issueRuntime());
    const list = vi.spyOn(issueEnvironment, "list").mockImplementation(atoms.list);
    state.load
      .mockReset()
      .mockImplementation((target) => atoms.listPage.run(appAtomRegistry, target));
    const capabilities = {
      create: false,
      edit: false,
      comment: false,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    };
    const row = (key: string) => ({
      ...state.linked,
      key,
      title: `Issue ${key}`,
      author: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      closedAt: null,
      labels: [],
      assignees: [],
      commentCount: 0,
    });
    const cursor = legacy ? "github.com org/repo" : "github github.com org/repo";
    const initial = {
      entries: [row("A-first")],
      sources: [{ ...state.source, capabilities }],
      trackers: [],
      viewers: { "github github.com": "A" },
      nextCursors: { [cursor]: "2" },
      errors: [],
    };
    const tail = { ...initial, entries: [row("A-tail")], nextCursors: { [cursor]: "3" } };
    const pageTwo = {
      ...initial,
      entries: [],
      viewers: { "github github.com": viewer },
      nextCursors: {},
    };
    const firstForB = { ...pageTwo, entries: empty ? [] : [row("B-only")] };
    const failure = {
      ...firstForB,
      entries: [],
      errors: [
        {
          projectId: "project",
          projectTitle: "Project",
          tracker: "github",
          host: "github.com",
          message: "First page unavailable",
        },
      ],
    };
    const replies = [
      initial,
      tail,
      pageTwo,
      ...(viewer === "B" ? [...(failFirst ? [failure] : []), firstForB] : []),
    ];
    const reads: Array<{ tag: string; input: unknown }> = [];
    const respond = ((tag: string, input: unknown) =>
      Effect.sync(() => {
        reads.push({ tag, input });
        return decodeIssueList(replies.shift());
      })) as unknown as typeof RpcClient.request;
    const request = vi.spyOn(RpcClient, "request").mockImplementation(respond);
    const guarded = vi.spyOn(RpcClient, "requestGuarded");
    guarded.mockImplementation(
      respond as unknown as Parameters<typeof guarded.mockImplementation>[0],
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === label,
      );
    try {
      openLinkThreadIssueDialog({
        environmentId: EnvironmentId.make("restart-environment"),
        threadId: ThreadId.make("restart-thread"),
      });
      const render = () =>
        root.render(
          createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
        );
      await act(async () => render());
      expect(document.body.textContent).toContain("Issue A-first");
      const draft = document.querySelector<HTMLInputElement>('[aria-label="Issue URL"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          draft,
          "https://github.com/org/repo/issues/99",
        );
        draft.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => button("Load more")!.click());
      expect(document.body.textContent).toContain("Issue A-tail");
      await act(async () => button("Load more")!.click());
      if (viewer === "B") {
        expect(document.body.textContent).not.toContain("Issue A-first");
        expect(document.body.textContent).not.toContain("Issue A-tail");
        if (failFirst) {
          expect(document.body.textContent).toContain("First page unavailable");
          expect(reads).toHaveLength(4);
          await act(async () => button("Retry")!.click());
          expect(document.body.textContent).not.toContain("First page unavailable");
        }
        if (empty) expect(document.body.textContent).toContain("No issues to link.");
        else expect(document.body.textContent).toContain("Issue B-only");
      } else {
        expect(document.body.textContent).toContain("Issue A-first");
        expect(document.body.textContent).toContain("Issue A-tail");
      }
      expect(draft.value).toBe("https://github.com/org/repo/issues/99");
      expect(reads.map(({ tag }) => tag)).toEqual(
        Array(viewer === "B" ? (failFirst ? 5 : 4) : 3).fill(WS_METHODS.issuesList),
      );
      expect(reads[1]!.input).toMatchObject({ cursors: { [cursor]: "2" } });
      expect(reads[2]!.input).toMatchObject({ cursors: { [cursor]: "3" } });
      for (const { input } of reads.slice(3)) {
        expect(input).toMatchObject({ projectId: "project", limit: 50 });
        expect(input).not.toHaveProperty("cursors");
      }
      await act(async () => render());
      expect(reads).toHaveLength(viewer === "B" ? (failFirst ? 5 : 4) : 3);
      expect(replies).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      appAtomRegistry.reset();
      list.mockRestore();
      request.mockRestore();
      guarded.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

function issueRuntime() {
  return Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const connection = yield* SubscriptionRef.make({ phase: "connected" } as const);
        const session = yield* SubscriptionRef.make(Option.some({}));
        const supervisor = {
          state: connection,
          session,
        } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      }),
    ),
  );
}

it("refreshes the dialog twice over its last first-page result", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const atoms = createIssueEnvironmentAtoms(issueRuntime());
  const list = vi.spyOn(issueEnvironment, "list").mockImplementation(atoms.list);
  state.load
    .mockReset()
    .mockImplementation((target) => atoms.listPage.run(appAtomRegistry, target));
  const capabilities = {
    create: false,
    edit: false,
    comment: false,
    labels: false,
    assignees: false,
    reactions: false,
    templates: false,
    linkedPullRequests: false,
    events: false,
    search: true,
    states: [],
    closeReasons: [],
  };
  const cursor = "github github.com org/repo";
  const first = (keys: ReadonlyArray<string>) => ({
    entries: keys.map((key) => ({
      ...state.linked,
      key,
      title: `Issue ${key}`,
      author: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      closedAt: null,
      labels: [],
      assignees: [],
      commentCount: 0,
    })),
    sources: [{ ...state.source, capabilities }],
    viewers: { "github github.com": "A" },
    trackers: [],
    nextCursors: { [cursor]: "2" },
    errors: [
      {
        projectId: "project",
        projectTitle: "Project",
        tracker: "gitlab",
        host: "gitlab.com",
        message: "Other tracker unavailable",
      },
    ],
  });
  const replies = [
    first(["2", "3"]),
    { ...first(["4"]), nextCursors: {}, errors: [] },
    first(["4", "2"]),
    first(["2", "3"]),
  ];
  const reads: Array<{ tag: string; input: unknown }> = [];
  const respond = ((tag: string, input: unknown) =>
    Effect.sync(() => {
      reads.push({ tag, input });
      return decodeIssueList(replies.shift());
    })) as unknown as typeof RpcClient.request;
  const request = vi.spyOn(RpcClient, "request").mockImplementation(respond);
  const guarded = vi.spyOn(RpcClient, "requestGuarded");
  guarded.mockImplementation(
    respond as unknown as Parameters<typeof guarded.mockImplementation>[0],
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label,
    )!;
  const text = () => document.body.textContent ?? "";
  const render = () =>
    root.render(
      createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
    );
  try {
    openLinkThreadIssueDialog({
      environmentId: EnvironmentId.make("chain-environment"),
      threadId: ThreadId.make("chain-thread"),
    });
    await act(async () => render());
    await act(async () => button("Load more").click());
    expect(text()).toContain("Issue 4");
    await act(async () => button("Retry").click());
    expect(text()).toContain("Issue 4");
    expect(text()).not.toContain("Issue 3");
    await act(async () => button("Retry").click());
    expect(text()).toContain("Issue 2");
    expect(text()).toContain("Issue 3");
    expect(text()).not.toContain("Issue 4");
    expect(text()).toContain("Other tracker unavailable");
    expect(reads.map(({ tag }) => tag)).toEqual(Array(4).fill(WS_METHODS.issuesList));
    expect(reads[1]!.input).toMatchObject({ cursors: { [cursor]: "2" } });
    for (const { input } of [reads[0]!, ...reads.slice(2)])
      expect(input).not.toHaveProperty("cursors");
    await act(async () => render());
    expect(reads).toHaveLength(4);
    expect(replies).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    appAtomRegistry.reset();
    list.mockRestore();
    request.mockRestore();
    guarded.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("ignores a changed viewer page after the dialog's query changed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cursor = "github github.com org/repo";
  const seed = state.list;
  state.list = {
    ...seed,
    entries: [{ ...state.linked, key: "A", title: "Old query issue" }],
    nextCursors: { [cursor]: "2" },
    viewers: { "github github.com": "A" },
  };
  let finish!: (value: unknown) => void;
  state.load.mockReset().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    openLinkThreadIssueDialog({
      environmentId: EnvironmentId.make("stale-environment"),
      threadId: ThreadId.make("stale-thread"),
    });
    await act(async () =>
      root.render(
        createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
      ),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Load more")!
        .click(),
    );
    state.list = {
      ...seed,
      entries: [{ ...state.linked, key: "Q", title: "Current query issue" }],
      nextCursors: {},
    };
    const query = document.querySelector<HTMLInputElement>('[aria-label="Search issues"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        query,
        "current",
      );
      query.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Current query issue");
    await act(async () =>
      finish({
        _tag: "Success",
        value: {
          ...seed,
          entries: [{ ...state.linked, key: "B", title: "Stale account issue" }],
          viewers: { "github github.com": "B" },
          nextCursors: {},
        },
      }),
    );
    expect(document.body.textContent).toContain("Current query issue");
    expect(document.body.textContent).not.toContain("Stale account issue");
    expect(state.load).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.list = seed;
    appAtomRegistry.reset();
    vi.unstubAllGlobals();
  }
});

it.each([false, true])(
  "shows native first-page errors and refreshes only on Retry, with rows: %s",
  async (withRows) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const atoms = createIssueEnvironmentAtoms(issueRuntime());
    const list = vi.spyOn(issueEnvironment, "list").mockImplementation(atoms.list);
    const capabilities = {
      create: false,
      edit: false,
      comment: false,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    };
    const candidate = {
      ...state.linked,
      key: "2",
      displayKey: "#2",
      title: "Recovered native issue",
      author: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      closedAt: null,
      labels: [],
      assignees: [],
      commentCount: 0,
    };
    const failure = {
      entries: withRows ? [candidate] : [],
      sources: [{ ...state.source, capabilities }],
      trackers: [],
      viewers: { "github github.com": "A" },
      nextCursors: withRows ? { "github github.com org/repo": "2" } : {},
      errors: [
        {
          projectId: "project",
          projectTitle: "Project",
          tracker: "github",
          host: "github.com",
          message: "Native API rate limit reached",
        },
      ],
    };
    const replies = [failure, { ...failure, entries: [candidate], errors: [] }];
    const request = vi.spyOn(RpcClient, "request");
    request.mockImplementation(((tag: string) =>
      Effect.sync(() => {
        expect(tag).toBe(WS_METHODS.issuesList);
        return decodeIssueList(replies.shift());
      })) as unknown as Parameters<typeof request.mockImplementation>[0]);
    const guarded = vi.spyOn(RpcClient, "requestGuarded");
    const { executeAtomQuery } = await vi.importActual<
      typeof import("@t3tools/client-runtime/state/runtime")
    >("@t3tools/client-runtime/state/runtime");
    const target = {
      environmentId: EnvironmentId.make("error-environment"),
      input: {
        state: "all" as const,
        projectId: state.source.projectId as IssueListResult["entries"][number]["projectId"],
        limit: 50,
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      openLinkThreadIssueDialog({
        environmentId: target.environmentId,
        threadId: ThreadId.make("error-thread"),
      });
      await act(async () => {
        root.render(
          createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
        );
        await executeAtomQuery(appAtomRegistry, atoms.list(target));
      });
      expect(document.body.textContent).toContain("Native API rate limit reached");
      expect(document.body.textContent).not.toContain("No issues to link.");
      expect(document.body.textContent?.split("Native API rate limit reached")).toHaveLength(2);
      expect(request).toHaveBeenCalledTimes(1);
      const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Retry",
      );
      expect(retry).toBeDefined();
      if (withRows) expect(document.body.textContent).toContain(candidate.title);
      await act(async () => {
        retry!.click();
        await executeAtomQuery(appAtomRegistry, atoms.list(target));
      });
      expect(document.body.textContent).toContain(candidate.title);
      expect(document.body.textContent).not.toContain("Native API rate limit reached");
      expect(request).toHaveBeenCalledTimes(2);
      expect(guarded).not.toHaveBeenCalled();
      expect(replies).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      appAtomRegistry.reset();
      list.mockRestore();
      request.mockRestore();
      guarded.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

it("can load later issues when every issue on the first page is already linked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.load.mockResolvedValue({
    _tag: "Success",
    value: {
      entries: [{ ...state.linked, key: "2", title: "Later issue" }],
      nextCursors: {},
      errors: [],
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    openLinkThreadIssueDialog({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    });
    await act(async () =>
      root.render(
        createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
      ),
    );
    const load = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Load more",
    );
    expect(load).toBeDefined();
    await act(async () => load!.click());
    expect(state.load).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Later issue");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows a source page failure and retries its qualified cursor without paging another tracker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const github = "github github.com org/repo";
  state.list = {
    ...state.list,
    nextCursors: { [github]: "next", "gitlab github.com org/repo": "other" },
  };
  state.load
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        entries: [],
        nextCursors: {},
        errors: [
          {
            projectId: state.source.projectId,
            projectTitle: "Project",
            tracker: "github",
            host: "github.com",
            message: "Provider offline",
          },
        ],
      },
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        entries: [{ ...state.linked, key: "2", title: "Retried issue" }],
        nextCursors: {},
        errors: [],
      },
    });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    openLinkThreadIssueDialog({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    });
    await act(async () =>
      root.render(
        createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
      ),
    );
    const more = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Load more",
      );
    await act(async () => more()!.click());
    expect(document.body.textContent).toContain("Provider offline");
    expect(more()).toBeDefined();
    await act(async () => more()!.click());
    expect(state.load).toHaveBeenCalledTimes(2);
    for (const [request] of state.load.mock.calls)
      expect(request.input.cursors).toEqual({ [github]: "next" });
    expect(document.body.textContent).toContain("Retried issue");
    expect(document.body.textContent).not.toContain("Provider offline");
    expect(more()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([false, true])(
  "drops the old account's candidates after a new account page, empty: %s",
  async (empty) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const cursor = "github github.com org/repo";
    const row = (key: string) => ({ ...state.linked, key, title: `Issue ${key}` });
    state.list = {
      ...state.list,
      entries: [row("A-first")],
      viewers: { "github github.com": "A" },
      nextCursors: { [cursor]: "A2" },
    };
    const page = (key: string | null, viewer: string, next: string | null) => ({
      entries: key === null ? [] : [row(key)],
      viewers: { "github github.com": viewer },
      sources: [state.source],
      errors: [],
      nextCursors: next === null ? {} : { [cursor]: next },
    });
    state.load
      .mockReset()
      .mockResolvedValueOnce({ _tag: "Success", value: page("A-tail", "A", "A3") })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: page(empty ? null : "B-tail", "B", empty ? null : "B2"),
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: {
          ...page(null, "B", null),
          errors: [
            {
              projectId: state.source.projectId,
              projectTitle: "Project",
              tracker: "github",
              host: "github.com",
              message: "Provider offline",
            },
          ],
        },
      })
      .mockResolvedValueOnce({ _tag: "Success", value: page("B-retried", "B", null) });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const more = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Load more",
      );
    const text = () => document.body.textContent ?? "";
    try {
      openLinkThreadIssueDialog({
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
      });
      await act(async () =>
        root.render(
          createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
        ),
      );
      expect(text()).toContain("Issue A-first");
      await act(async () => more()!.click());
      expect(text()).toContain("Issue A-first");
      expect(text()).toContain("Issue A-tail");
      await act(async () => more()!.click());
      expect(text()).not.toContain("Issue A-first");
      expect(text()).not.toContain("Issue A-tail");
      if (empty) {
        expect(text()).toContain("No issues to link.");
        expect(more()).toBeUndefined();
      } else {
        expect(text()).toContain("Issue B-tail");
        await act(async () => more()!.click());
        expect(text()).toContain("Provider offline");
        expect(text()).toContain("Issue B-tail");
        await act(async () => more()!.click());
        expect(text()).toContain("Issue B-tail");
        expect(text()).toContain("Issue B-retried");
        expect(text()).not.toContain("Issue A-first");
        expect(text()).not.toContain("Issue A-tail");
        expect(text()).not.toContain("Provider offline");
        expect(more()).toBeUndefined();
      }
      expect(state.load.mock.calls.map(([request]) => request.input.cursors)).toEqual(
        empty
          ? [{ [cursor]: "A2" }, { [cursor]: "A3" }]
          : [{ [cursor]: "A2" }, { [cursor]: "A3" }, { [cursor]: "B2" }, { [cursor]: "B2" }],
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it.each(["key", "url", "listed", "unsupported-url"])(
  "reuses detail for a direct link and preserves no-detail URL paths (%s)",
  async (path) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const native = {
      ...state.linked,
      key: "42",
      displayKey: "#42",
      title: "Native detail title",
      url: "https://github.com/org/repo/issues/42",
    };
    state.list = { ...state.list, entries: [native], nextCursors: {} };
    state.read.mockReset().mockResolvedValue({ _tag: "Success", value: native });
    state.link.mockReset().mockResolvedValue({ _tag: "Success" });
    state.resolve.mockReset().mockResolvedValue(
      path === "unsupported-url"
        ? { _tag: "Failure" }
        : {
            _tag: "Success",
            value: {
              projectId: native.projectId,
              tracker: native.tracker,
              host: native.host,
              scope: native.scope,
              key: native.key,
              writable: true,
            },
          },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      openLinkThreadIssueDialog({
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
      });
      await act(async () =>
        root.render(
          createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
        ),
      );
      if (path === "listed") {
        const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Native detail title"),
        )!;
        await act(async () => row.click());
      } else {
        const input = document.querySelector<HTMLInputElement>(
          path === "key" ? 'input[aria-label="Issue key"]' : 'input[aria-label="Issue URL"]',
        )!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            input,
            path === "key" ? "42" : native.url,
          );
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () =>
          input
            .closest("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
      }
      if (path === "unsupported-url") {
        expect(state.link).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("failed");
      } else {
        expect(state.link).toHaveBeenCalledOnce();
        const request = state.link.mock.calls[0]![0];
        expect(request.input).toMatchObject({
          threadId: "thread",
          key: "42",
          url: native.url,
          source: "manual",
        });
        if (path === "key") {
          expect(request.input.snapshot).toMatchObject({
            displayKey: "#42",
            title: native.title,
            state: native.state,
          });
          expect(Number.isNaN(Date.parse(request.input.snapshot.syncedAt))).toBe(false);
        } else expect(request.input.snapshot).toBeUndefined();
      }
      expect(state.read).toHaveBeenCalledTimes(path === "key" ? 1 : 0);
      expect(state.resolve).toHaveBeenCalledTimes(
        path === "url" || path === "unsupported-url" ? 1 : 0,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  ["cross-tracker", "linear", "linear.app", "https://acme.atlassian.net/browse/ENG-42", undefined],
  [
    "cross-host",
    "jira",
    "acme.atlassian.net",
    "https://other.atlassian.net/browse/ENG-42",
    undefined,
  ],
  [
    "cross-port",
    "forgejo",
    "forgejo.test:8443",
    "https://forgejo.test:9443/team/repo/issues/42",
    undefined,
  ],
  [
    "same-host-tracker",
    "github",
    "git.example",
    "https://git.example/team/repo/-/issues/42",
    undefined,
  ],
  ["same-source", "jira", "ACME.ATLASSIAN.NET", "https://acme.atlassian.net/browse/ENG-42", "B"],
  [
    "same-port",
    "forgejo",
    "forgejo.test:8443",
    "https://forgejo.test:8443/team/repo/issues/42",
    "B",
  ],
  ["choice", "jira", "acme.atlassian.net", "https://acme.atlassian.net/browse/ENG-42", "B"],
  ["refused", "jira", "acme.atlassian.net", "https://acme.atlassian.net/browse/ENG-42", "B"],
] as const)(
  "scopes the pasted URL account (%s)",
  async (scenario, tracker, host, url, connectionId) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const original = state.list;
    const selected = {
      ...state.source,
      tracker,
      host,
      scope: tracker === "jira" ? "ENG" : tracker === "linear" ? "acme/ENG" : "team/repo",
      connectionId: "B",
    };
    const first = { ...state.source, tracker: "linear", host: "linear.app", connectionId: "A" };
    state.list = {
      ...original,
      sources: scenario === "choice" ? [first, selected] : [selected],
      entries: [],
      nextCursors: {},
    };
    const query = Atom.make(AsyncResult.success(decodeIssueList(state.list))).pipe(Atom.keepAlive);
    const list = vi.spyOn(issueEnvironment, "list").mockReturnValue(query);
    const payload = WsIssuesRpcGroup.requests.get(WS_METHODS.issuesResolveUrl)!.payloadSchema;
    let decoded: unknown;
    const resolved = {
      projectId: "project",
      ...parseIssueUrl(url, { tracker, host })!,
      writable: true,
      ...(connectionId === undefined ? {} : { connectionId }),
    };
    state.resolve.mockReset().mockImplementation(async ({ input }) => {
      decoded = Schema.decodeSync(payload)(Schema.encodeSync(payload)(input));
      return scenario === "refused" ? { _tag: "Failure" } : AsyncResult.success(resolved);
    });
    state.link.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    state.read.mockReset();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      openLinkThreadIssueDialog({
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
      });
      await act(async () =>
        root.render(
          createElement(AppAtomRegistryProvider, null, createElement(LinkThreadIssueDialogHost)),
        ),
      );
      if (scenario === "choice") {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>('[aria-label="Issue source"]')!
            .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
        );
        const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
          node.textContent?.endsWith(" · B"),
        )!;
        await act(async () => option.click());
      }
      const input = document.querySelector<HTMLInputElement>('[aria-label="Issue URL"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, url);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        input
          .closest("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
        environmentId: "environment",
        input: {
          url,
          projectId: "project",
          ...(connectionId === undefined ? {} : { connectionId }),
        },
      });
      expect(decoded).toEqual({
        url,
        projectId: "project",
        ...(connectionId === undefined ? {} : { connectionId }),
      });
      expect(state.read).not.toHaveBeenCalled();
      if (scenario === "refused") {
        expect(state.link).not.toHaveBeenCalled();
        expect(input.value).toBe(url);
        expect(document.body.textContent).toContain("failed");
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      } else {
        expect(state.link).toHaveBeenCalledExactlyOnceWith({
          environmentId: "environment",
          input: { threadId: "thread", ...resolved, url, source: "manual" },
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.list = original;
      list.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);
