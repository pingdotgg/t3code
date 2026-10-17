// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  WS_METHODS,
  IssueDetail,
  IssueHierarchyPage,
  IssueHistoryPage,
  IssueLinkedPullRequestsPage,
  IssueDependenciesPage,
  IssueCommentsPage,
  type IssueListOrder,
  type IssueComment,
  type IssueDependencyDirection,
  type AuthSessionState,
  type IssueRef,
} from "@t3tools/contracts";
import type {
  EnvironmentRegistry as Registry,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  read: vi.fn<
    (
      tag: string,
      input: IssueRef & {
        cursor?: string;
        order?: IssueListOrder;
        viewer?: string;
        direction?: IssueDependencyDirection;
      },
    ) => unknown
  >(),
  writes: vi.fn(),
  newer: false,
  failedDetail: false,
  failedRelated: false,
  failedComments: false,
  failedDependencies: false,
}));
vi.mock("../../../../../packages/client-runtime/src/rpc/client.ts", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  const { IssueOperationError, WS_METHODS } = await import("@t3tools/contracts");
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/rpc")>()),
    request: (
      tag: string,
      input: IssueRef & {
        cursor?: string;
        order?: IssueListOrder;
        viewer?: string;
        direction?: IssueDependencyDirection;
      },
    ) =>
      Effect.gen(function* () {
        const value = yield* Effect.promise(async () => state.read(tag, input));
        if (tag === WS_METHODS.issuesDetail && state.failedDetail)
          return yield* new IssueOperationError({
            operation: "getIssue",
            detail: "Native detail unavailable",
          });
        if (
          (tag === WS_METHODS.issuesLinkedPullRequests || tag === WS_METHODS.issuesHierarchy) &&
          state.failedRelated
        )
          return yield* new IssueOperationError({
            operation: tag,
            detail: "Native related data unavailable",
          });
        if (tag === WS_METHODS.issuesDependencies && state.failedDependencies)
          return yield* new IssueOperationError({
            operation: "dependencies",
            detail: "Native dependency read failed",
          });
        if (tag === WS_METHODS.issuesComments && state.failedComments)
          return yield* new IssueOperationError({
            operation: "comments",
            detail: "Native comments unavailable",
          });
        return value;
      }),
    requestGuarded: (tag: string, input: unknown) => Effect.sync(() => state.writes(tag, input)),
  };
});
vi.mock("~/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Stream = await import("effect/Stream");
  const Option = await import("effect/Option");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.effect(
        EnvironmentRegistry.EnvironmentRegistry,
        Effect.gen(function* () {
          const supervisor = {
            state: yield* SubscriptionRef.make({ phase: "connected" }),
            session: yield* SubscriptionRef.make(Option.some({})),
          } as unknown as Supervisor.EnvironmentSupervisor["Service"];
          return EnvironmentRegistry.EnvironmentRegistry.of({
            run: (_id, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
            followStream: (_id, stream) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as Registry.EnvironmentRegistry["Service"]);
        }),
      ),
    ),
  };
});
vi.mock("../../../../../packages/client-runtime/src/state/session.ts", async (importOriginal) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { AuthOrchestrationReadScope, AuthSourceControlWriteScope } =
    await import("@t3tools/contracts");
  const session = Atom.make(
    AsyncResult.success<AuthSessionState>({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
      permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
    }),
  );
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/session")>()),
    createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => session }),
  };
});
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("./useIssueThreadHandoff", () => ({
  useIssueThreadHandoff: () => ({ pending: false, start: vi.fn() }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../pullRequest/PullRequestCommentBody", () => ({
  PullRequestCommentBody: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { issueEnvironment } from "~/state/issues";
import { IssueDetailPanel } from "./IssueDetailPanel";

const decodeDetail = Schema.decodeUnknownSync(IssueDetail);
const decodeHierarchy = Schema.decodeUnknownSync(IssueHierarchyPage);
const decodeHistory = Schema.decodeUnknownSync(IssueHistoryPage);
const decodeLinkedPullRequests = Schema.decodeUnknownSync(IssueLinkedPullRequestsPage);
const environmentId = EnvironmentId.make("refresh-environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "1",
};
const capabilities = {
  create: false,
  edit: false,
  comment: false,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: true,
  events: false,
  subIssues: true,
  updateParent: false,
  states: [],
  closeReasons: [],
  search: true,
};
const issue = {
  ...reference,
  projectTitle: "Project",
  displayKey: "#1",
  title: "Issue",
  body: "",
  url: "https://github.com/org/repo/issues/1",
  author: null,
  viewer: "viewer",
  state: { category: "open", name: "open" },
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  closedAt: null,
  labels: [],
  assignees: [],
  comments: [],
  commentsCursor: null,
  events: [],
  linkedPullRequests: [],
  commentCount: 0,
  writable: true,
  viewerPermissions: {
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
    setState: false,
  },
  capabilities,
};
let root: Root;
let container: HTMLDivElement;
const observers = new Map<Element, IntersectionObserverCallback>();
const intersect = (section: Element) => {
  for (const [target, callback] of observers)
    if (section.contains(target))
      callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  observers.clear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      targets = new Set<Element>();
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        observers.set(target, this.callback);
      }
      disconnect() {
        for (const target of this.targets) observers.delete(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        observers.delete(target);
      }
    },
  );
  state.read.mockReset();
  state.writes.mockReset();
  state.newer = false;
  state.failedDetail = false;
  state.failedRelated = false;
  state.failedComments = false;
  state.failedDependencies = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  appAtomRegistry.reset();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === label,
  )!;

it.each(["supported", "unmounted", "unsupported", "failed-detail", "failed-related"])(
  "refreshes only supported mounted first pages from the header (%s)",
  async (kind) => {
    const supported = kind !== "unsupported";
    state.failedDetail = kind === "failed-detail";
    state.failedRelated = kind === "failed-related";
    state.read.mockImplementation((tag, input) => {
      const prefix = state.newer ? "New" : "Old";
      const number = input.cursor === undefined ? (state.newer ? 3 : 2) : 4;
      switch (tag) {
        case WS_METHODS.issuesDetail:
          return decodeDetail({
            ...issue,
            title: `${prefix} issue`,
            capabilities: {
              ...capabilities,
              linkedPullRequests: supported,
              subIssues: supported,
              events: kind === "unmounted",
            },
          });
        case WS_METHODS.issuesLinkedPullRequests:
          return decodeLinkedPullRequests({
            items: [
              {
                provider: "github",
                host: "github.com",
                repository: "org/repo",
                number,
                title: `${prefix} PR${input.cursor ? " tail" : ""}`,
                url: `https://github.com/org/repo/pull/${number}`,
                state: "open",
                isDraft: false,
                closesIssue: true,
              },
            ],
            nextCursor: input.cursor === undefined ? "pr-tail" : null,
          });
        case WS_METHODS.issuesHierarchy:
          return decodeHierarchy({
            parent: null,
            children: {
              items: [
                {
                  scope: "org/repo",
                  key: String(number),
                  displayKey: `#${number}`,
                  title: `${prefix} child${input.cursor ? " tail" : ""}`,
                  url: `https://github.com/org/repo/issues/${number}`,
                  state: { category: "open", name: "open" },
                },
              ],
              nextCursor: input.cursor === undefined ? "child-tail" : null,
            },
          });
        case WS_METHODS.issuesHistory:
          return decodeHistory({ items: [], nextCursor: null });
        default:
          throw new Error(`Unexpected RPC ${tag}`);
      }
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={reference} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: reference }),
      );
    });
    if (state.failedDetail) {
      expect(container.textContent).toContain("Could not load this issue");
      expect(container.querySelector('[aria-label="Refresh issue"]')).toBeNull();
      expect(state.read.mock.calls.map(([tag]) => tag)).toEqual([WS_METHODS.issuesDetail]);
      let release = () => {};
      state.read.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(null))),
      );
      await act(async () => button("Retry").click());
      expect(container.textContent).not.toContain("Could not load this issue");
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(state.read.mock.calls.map(([tag]) => tag)).toEqual([
        WS_METHODS.issuesDetail,
        WS_METHODS.issuesDetail,
      ]);
      release();
      return;
    }
    if (supported) {
      await act(async () => {
        await Promise.all([
          executeAtomQuery(
            appAtomRegistry,
            issueEnvironment.linkedPullRequests({ environmentId, input: reference }),
          ),
          executeAtomQuery(
            appAtomRegistry,
            issueEnvironment.hierarchy({ environmentId, input: reference }),
          ),
        ]);
      });
      if (!state.failedRelated) {
        expect(container.textContent).toContain("Old PR");
        expect(container.textContent).toContain("Old child");
        await act(async () => intersect(container.querySelector('[aria-label="Hierarchy"]')!));
        expect(container.textContent).toContain("Old PR tail");
        expect(container.textContent).toContain("Old child tail");
      }
    }
    if (kind === "unmounted") {
      await act(async () => button("History").click());
      await act(async () => {
        await executeAtomQuery(
          appAtomRegistry,
          issueEnvironment.history({ environmentId, input: { ...reference, order: "desc" } }),
        );
      });
      expect(container.querySelector('[aria-label="Hierarchy"]')).toBeNull();
    }
    const before = state.read.mock.calls.length;
    state.newer = true;
    state.failedRelated = false;
    state.failedDependencies = false;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh issue"]')!.click(),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: reference }),
      );
    });
    expect(container.textContent).toContain("New issue");
    if (supported && kind !== "unmounted") {
      expect(container.textContent).toContain("New PR");
      expect(container.textContent).toContain("New child");
      expect(container.textContent).not.toContain("Old PR tail");
      expect(container.textContent).not.toContain("Old child tail");
    }
    const expected = [
      WS_METHODS.issuesDetail,
      ...(supported
        ? [WS_METHODS.issuesLinkedPullRequests, WS_METHODS.issuesLinkedPullRequests]
        : []),
      ...(supported && kind !== "unmounted" ? [WS_METHODS.issuesHierarchy] : []),
      ...(kind === "unmounted" ? [WS_METHODS.issuesHistory] : []),
    ];
    const calls = state.read.mock.calls.slice(before);
    expect(calls.map(([tag]) => tag).toSorted()).toEqual(expected.toSorted());
    for (const [tag, input] of calls)
      expect(input).toEqual(
        tag === WS_METHODS.issuesHistory
          ? { ...reference, order: "desc" }
          : input.cursor === undefined
            ? reference
            : { ...reference, cursor: "pr-tail" },
      );
    expect(state.writes).not.toHaveBeenCalled();
  },
);

it("reads one dependency page per direction, accumulates pages and retries a failed read", async () => {
  const nativeRef = { ...reference, connectionId: "Account-B" };
  const decodeDependencies = Schema.decodeUnknownSync(IssueDependenciesPage);
  state.read.mockImplementation((tag, input) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        ...nativeRef,
        capabilities: {
          ...capabilities,
          linkedPullRequests: false,
          subIssues: false,
          dependencies: true,
        },
      });
    if (tag === WS_METHODS.issuesDependencies)
      return decodeDependencies({
        items: [
          {
            scope: "native/repo",
            key: input.cursor ? "3" : "2",
            displayKey: input.cursor ? "!3" : "!2",
            title: input.cursor ? "Next native PR" : "First native PR",
            kind: "pull-request",
            url: "https://native.example/pulls/2",
            state: { category: "open", name: "open" },
          },
        ],
        nextCursor: input.cursor ? null : "native-tail",
      });
    throw new Error("Unexpected RPC " + tag);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: nativeRef }),
    );
  });
  await act(async () => {
    await Promise.all(
      (["blocks", "blocked-by"] as const).map((direction) =>
        executeAtomQuery(
          appAtomRegistry,
          issueEnvironment.dependencies({
            environmentId,
            input: { ...nativeRef, direction, limit: 100 },
          }),
        ),
      ),
    );
  });
  const reads = state.read.mock.calls.filter(([tag]) => tag === WS_METHODS.issuesDependencies);
  expect(reads.map(([, input]) => input)).toEqual(
    expect.arrayContaining([
      { ...nativeRef, direction: "blocks", limit: 100 },
      { ...nativeRef, direction: "blocked-by", limit: 100 },
    ]),
  );
  expect(reads).toHaveLength(2);
  const blocks = container.querySelector('[aria-label="Blocks"]')!;
  const blockedBy = container.querySelector('[aria-label="Blocked by"]')!;
  expect(blocks.querySelector<HTMLAnchorElement>("a")?.href).toBe("https://native.example/pulls/2");
  expect(blocks.textContent).toContain("First native PR");
  await act(async () => intersect(blocks));
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.dependencies({
        environmentId,
        input: { ...nativeRef, direction: "blocks", limit: 100, cursor: "native-tail" },
      }),
    );
  });
  expect(blocks.textContent).toContain("Next native PR");
  expect(blocks.textContent).toContain("First native PR");
  expect(blockedBy.textContent).toContain("First native PR");
  state.failedDependencies = true;
  await act(async () => {
    appAtomRegistry.refresh(
      issueEnvironment.dependencies({
        environmentId,
        input: { ...nativeRef, direction: "blocked-by", limit: 100 },
      }),
    );
  });
  expect(blockedBy.textContent).toContain("Native dependency read failed");
  state.failedDependencies = false;
  await act(async () =>
    [...blockedBy.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent === "Retry dependencies")!
      .click(),
  );
  expect(blockedBy.textContent).not.toContain("Native dependency read failed");
  expect(state.writes).not.toHaveBeenCalled();
});

it.each(["success", "failed-refresh", "unsupported", "unmounted"])(
  "refreshes dependency directions from the first page after continuation (%s)",
  async (kind) => {
    const nativeRef = { ...reference, connectionId: "Account-B" };
    const supported = kind !== "unsupported";
    const decodeDependencies = Schema.decodeUnknownSync(IssueDependenciesPage);
    state.read.mockImplementation((tag, input) => {
      if (tag === WS_METHODS.issuesDetail)
        return decodeDetail({
          ...issue,
          ...nativeRef,
          title: state.newer ? "New issue" : "Old issue",
          capabilities: {
            ...capabilities,
            linkedPullRequests: false,
            subIssues: false,
            events: true,
            dependencies: supported,
          },
        });
      if (tag === WS_METHODS.issuesHistory) return decodeHistory({ items: [], nextCursor: null });
      if (tag === WS_METHODS.issuesDependencies)
        return decodeDependencies({
          items: Array.from({ length: input.cursor ? 1 : 50 }, (_, index) => ({
            scope: "native/repo",
            key: input.cursor ? "51" : String(index + 1),
            displayKey: input.cursor ? "#51" : `#${index + 1}`,
            title: `${state.newer ? "New" : "Old"} ${input.direction} ${input.cursor ? "tail" : index + 1}`,
            kind: "pull-request",
            url: `https://native.example/pulls/${input.cursor ? "51" : index + 1}`,
            state: { category: "open", name: "open" },
          })),
          nextCursor: input.cursor ? null : "native-tail",
        });
      throw new Error(`Unexpected RPC ${tag}`);
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: nativeRef }),
      );
    });
    if (supported) {
      await act(async () => {
        await Promise.all(
          (["blocks", "blocked-by"] as const).map((direction) =>
            executeAtomQuery(
              appAtomRegistry,
              issueEnvironment.dependencies({
                environmentId,
                input: { ...nativeRef, direction, limit: 100 },
              }),
            ),
          ),
        );
      });
      for (const title of ["Blocks", "Blocked by"]) {
        const section = container.querySelector(`[aria-label="${title}"]`)!;
        await act(async () => intersect(section));
        expect(section.querySelectorAll("a")).toHaveLength(51);
        expect(section.textContent).toContain("tail");
      }
    }
    if (kind === "unmounted") {
      await act(async () => button("History").click());
      await act(async () => {
        await executeAtomQuery(
          appAtomRegistry,
          issueEnvironment.history({ environmentId, input: { ...nativeRef, order: "desc" } }),
        );
      });
    }
    const before = state.read.mock.calls.length;
    state.newer = true;
    state.failedDependencies = kind === "failed-refresh";
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh issue"]')!.click(),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: nativeRef }),
      );
    });
    expect(container.textContent).toContain("New issue");
    const reads = state.read.mock.calls
      .slice(before)
      .filter(([tag]) => tag === WS_METHODS.issuesDependencies);
    if (!supported || kind === "unmounted") {
      expect(reads).toEqual([]);
    } else {
      expect(reads.map(([, input]) => input)).toEqual(
        expect.arrayContaining(
          (["blocks", "blocked-by"] as const).map((direction) => ({
            ...nativeRef,
            direction,
            limit: 100,
          })),
        ),
      );
      expect(reads).toHaveLength(2);
      for (const [title, direction] of [
        ["Blocks", "blocks"],
        ["Blocked by", "blocked-by"],
      ]) {
        const section = container.querySelector(`[aria-label="${title}"]`)!;
        expect(section.textContent).not.toContain("tail");
        if (kind === "failed-refresh") {
          expect(section.textContent).toContain("Retry dependencies");
          expect(section.textContent).not.toContain("Load more dependencies");
          expect(section.textContent).not.toContain(`New ${direction}`);
          state.failedDependencies = false;
          await act(async () =>
            [...section.querySelectorAll<HTMLButtonElement>("button")]
              .find((node) => node.textContent === "Retry dependencies")!
              .click(),
          );
          expect(section.querySelectorAll("a")).toHaveLength(50);
          expect(section.textContent).toContain(`New ${direction} 1`);
          expect(section.textContent).not.toContain("tail");
          state.failedDependencies = true;
        } else {
          expect(section.querySelectorAll("a")).toHaveLength(50);
          expect(section.textContent).toContain(`New ${direction} 1`);
          expect(section.textContent).not.toContain(`Old ${direction}`);
          await act(async () => intersect(section));
          expect(section.querySelectorAll("a")).toHaveLength(51);
          expect(section.textContent).toContain(`New ${direction} tail`);
        }
      }
    }
    expect(state.writes).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "uses updateParent permission instead of edit and keeps native external task links (%s)",
  async (updateParent) => {
    state.read.mockImplementation((tag) => {
      if (tag === WS_METHODS.issuesDetail)
        return decodeDetail({
          ...issue,
          capabilities: {
            ...capabilities,
            linkedPullRequests: false,
            subIssueNoun: "Tasks",
            updateParent: true,
          },
          viewerPermissions: { ...issue.viewerPermissions, edit: !updateParent, updateParent },
        });
      if (tag === WS_METHODS.issuesHierarchy)
        return decodeHierarchy({
          parent: null,
          children: {
            items: [
              {
                scope: "native/repo",
                key: "9",
                displayKey: "#9",
                title: "Native task",
                itemType: "task",
                externalOnly: true,
                url: "https://gitlab.example/native/repo/-/work_items/9",
                state: { category: "open", name: "open" },
              },
            ],
            nextCursor: null,
          },
        });
      throw new Error("Unexpected RPC " + tag);
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={reference} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: reference }),
      );
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.hierarchy({ environmentId, input: reference }),
      );
    });
    expect(button("Set parent") !== undefined).toBe(updateParent);
    const hierarchy = container.querySelector('[aria-label="Hierarchy"]')!;
    expect(hierarchy.textContent).toContain("Tasks");
    expect(hierarchy.querySelector<HTMLAnchorElement>("a")?.href).toBe(
      "https://gitlab.example/native/repo/-/work_items/9",
    );
    expect(
      [...hierarchy.querySelectorAll("button")].some((node) =>
        node.textContent?.includes("Native task"),
      ),
    ).toBe(false);
    if (updateParent) {
      await act(async () => button("Set parent").click());
      const input = container.querySelector<HTMLInputElement>('[aria-label="Parent issue key"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "7");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      updateParent = false;
      await act(async () => {
        appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: reference }));
      });
      expect(button("Save").disabled).toBe(true);
      await act(async () => button("Save").click());
    }
    expect(state.writes).not.toHaveBeenCalled();
  },
);

it.each(["success", "permission"])(
  "writes dependency add/remove with the selected account and current permissions (%s)",
  async (kind) => {
    const nativeRef = { ...reference, connectionId: "Account-B" };
    let writable = true;
    const decodeDependencies = Schema.decodeUnknownSync(IssueDependenciesPage);
    state.read.mockImplementation((tag) => {
      if (tag === WS_METHODS.issuesDetail)
        return decodeDetail({
          ...issue,
          ...nativeRef,
          capabilities: {
            ...capabilities,
            linkedPullRequests: false,
            subIssues: false,
            dependencies: true,
          },
          viewerPermissions: { ...issue.viewerPermissions, edit: writable },
        });
      if (tag === WS_METHODS.issuesDependencies)
        return decodeDependencies({
          items: [
            {
              scope: "native/repo",
              key: "2",
              displayKey: "#2",
              title: "Native dependency",
              kind: "issue",
              url: "https://native.example/issues/2",
              state: { category: "open", name: "open" },
            },
          ],
          nextCursor: null,
        });
      throw new Error("Unexpected RPC " + tag);
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: nativeRef }),
      );
      await Promise.all(
        (["blocks", "blocked-by"] as const).map((direction) =>
          executeAtomQuery(
            appAtomRegistry,
            issueEnvironment.dependencies({
              environmentId,
              input: { ...nativeRef, direction, limit: 100 },
            }),
          ),
        ),
      );
    });
    const blocks = container.querySelector('[aria-label="Blocks"]')!;
    await act(async () =>
      [...blocks.querySelectorAll<HTMLButtonElement>("button")]
        .find((node) => node.textContent === "Add dependency")!
        .click(),
    );
    const scope = document.querySelector<HTMLInputElement>("#dependency-scope-blocks")!;
    const key = document.querySelector<HTMLInputElement>("#dependency-key-blocks")!;
    await act(async () => {
      for (const [field, value] of [
        [scope, "target/repo"],
        [key, "7"],
      ] as const) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          value,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const add = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (node) => node.textContent === "Add dependency",
      )!;
    if (kind === "permission") {
      writable = false;
      await act(async () => {
        appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: nativeRef }));
      });
      expect(add().disabled).toBe(true);
      await act(async () => add().click());
      expect(state.writes).not.toHaveBeenCalled();
      return;
    }
    await act(async () => add().click());
    expect(state.writes.mock.calls[0]).toEqual([
      WS_METHODS.issuesSetDependency,
      {
        ...nativeRef,
        direction: "blocks",
        targetScope: "target/repo",
        targetKey: "7",
        linked: true,
      },
    ]);
    await act(async () =>
      blocks.querySelector<HTMLButtonElement>('[aria-label="Remove dependency #2"]')!.click(),
    );
    expect(state.writes.mock.calls[1]).toEqual([
      WS_METHODS.issuesSetDependency,
      {
        ...nativeRef,
        direction: "blocks",
        targetScope: "native/repo",
        targetKey: "2",
        linked: false,
      },
    ]);
  },
);

it("loads every linked PR page once, keeps three rows, and expands without new reads", async () => {
  state.read.mockImplementation((tag, input) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({ ...issue, capabilities: { ...capabilities, subIssues: false } });
    if (tag === WS_METHODS.issuesLinkedPullRequests) {
      const page = input.cursor === undefined ? 0 : Number(input.cursor);
      return decodeLinkedPullRequests({
        items: Array.from({ length: 2 }, (_, index) => {
          const number = page * 2 + index + 2;
          return {
            repository: "org/repo",
            number,
            title: `Linked PR ${number}`,
            url: `https://github.com/org/repo/pull/${number}`,
            state: "open",
            isDraft: false,
            closesIssue: false,
          };
        }),
        nextCursor: page < 2 ? String(page + 1) : null,
      });
    }
    throw new Error(`Unexpected RPC ${tag}`);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={reference} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: reference }),
    );
  });
  const reads = () =>
    state.read.mock.calls.filter(([tag]) => tag === WS_METHODS.issuesLinkedPullRequests);
  expect(reads().map(([, input]) => input.cursor)).toEqual([undefined, "1", "2"]);
  expect(container.querySelectorAll('a[href*="/pull/"]')).toHaveLength(3);
  expect(container.textContent).not.toContain("Load more pull requests");
  await act(async () => button("Show 3 more").click());
  expect(container.querySelectorAll('a[href*="/pull/"]')).toHaveLength(6);
  await act(async () => button("Show less").click());
  expect(container.querySelectorAll('a[href*="/pull/"]')).toHaveLength(3);
  expect(reads()).toHaveLength(3);
  expect(state.writes).not.toHaveBeenCalled();
});

const nativeComment = (id: string, day: number): IssueComment => ({
  id,
  author: null,
  body: id,
  createdAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`,
  url: null,
});

it("retains linked PRs on a failed continuation, retries once, and stops a repeated cursor", async () => {
  let attempts = 0;
  state.read.mockImplementation((tag, input) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({ ...issue, capabilities: { ...capabilities, subIssues: false } });
    if (tag === WS_METHODS.issuesLinkedPullRequests) {
      if (input.cursor) {
        attempts++;
        state.failedRelated = attempts === 1;
      }
      const number = input.cursor ? 3 : 2;
      return decodeLinkedPullRequests({
        items: [
          {
            repository: "org/repo",
            number,
            title: `Retained PR ${number}`,
            url: `https://github.com/org/repo/pull/${number}`,
            state: "open",
            isDraft: false,
            closesIssue: false,
          },
        ],
        nextCursor: "same-cursor",
      });
    }
    throw new Error(`Unexpected RPC ${tag}`);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={reference} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: reference }),
    );
  });
  expect(container.textContent).toContain("Retained PR 2");
  expect(container.textContent).toContain("Native related data unavailable");
  expect(attempts).toBe(1);
  await act(async () => button("Retry linked pull requests").click());
  expect(container.textContent).toContain("Retained PR 2");
  expect(container.textContent).toContain("Retained PR 3");
  expect(container.textContent).not.toContain("Native related data unavailable");
  expect(attempts).toBe(2);
  expect(
    state.read.mock.calls
      .filter(([tag]) => tag === WS_METHODS.issuesLinkedPullRequests)
      .map(([, input]) => input.cursor),
  ).toEqual([undefined, "same-cursor", "same-cursor"]);
  await act(async () => intersect(container));
  expect(attempts).toBe(2);
});

it("drops late account A comments and PRs and resets expansion for the same issue and viewer on account B", async () => {
  const decodeComments = Schema.decodeUnknownSync(IssueCommentsPage);
  const finish: Array<() => void> = [];
  state.read.mockImplementation((tag, input) => {
    const account = input.connectionId!;
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        ...input,
        title: `${account} issue`,
        comments: [nativeComment(`${account} seed`, 20)],
        commentsCursor: `older-${account}`,
        events: [
          {
            id: "known-seed",
            kind: "updated",
            actor: null,
            detail: `${account} partial event`,
            createdAt: "2026-10-15T00:00:00Z",
          },
        ],
        historyTruncated: true,
        capabilities: { ...capabilities, subIssues: false, events: true, historyOrders: [] },
      });
    const value =
      tag === WS_METHODS.issuesComments
        ? decodeComments({
            comments: [nativeComment(`${account} tail comment`, 10)],
            nextCursor: null,
          })
        : decodeLinkedPullRequests({
            items: Array.from({ length: input.cursor ? 1 : 4 }, (_, index) => ({
              repository: "org/repo",
              number: input.cursor ? 6 : index + 2,
              title: `${account} PR ${index}`,
              url: `https://github.com/org/repo/pull/${input.cursor ? 6 : index + 2}`,
              state: "open",
              isDraft: false,
              closesIssue: false,
            })),
            nextCursor:
              account === "Account-A" && input.cursor === undefined ? "account-a-tail" : null,
          });
    if (account === "Account-A" && input.cursor !== undefined)
      return new Promise((resolve) => finish.push(() => resolve(value)));
    return value;
  });
  const render = (connectionId: string) =>
    act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel
            environmentId={environmentId}
            reference={{ ...reference, connectionId }}
          />
        </RegistryContext.Provider>,
      ),
    );
  await render("Account-A");
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({
        environmentId,
        input: { ...reference, connectionId: "Account-A" },
      }),
    );
  });
  await act(async () => button("Show 1 more").click());
  expect(container.querySelectorAll('a[href*="/pull/"]')).toHaveLength(4);
  expect(finish).toHaveLength(2);
  await render("Account-B");
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({
        environmentId,
        input: { ...reference, connectionId: "Account-B" },
      }),
    );
  });
  await act(async () => {
    for (const resolve of finish) resolve();
  });
  expect(container.textContent).not.toContain("Account-A");
  expect(container.textContent).toContain("Account-B seed");
  expect(container.textContent).toContain("Account-B tail comment");
  expect(container.textContent).toContain("Account-B partial event");
  expect(container.textContent).toContain(
    "History is incomplete and its global order is unavailable",
  );
  expect(container.querySelectorAll('a[href*="/pull/"]')).toHaveLength(3);
  expect(button("Show 1 more")).toBeDefined();
  expect(
    state.read.mock.calls
      .filter(([, input]) => input.connectionId === "Account-B")
      .map(([tag]) => tag),
  ).toEqual([
    WS_METHODS.issuesDetail,
    WS_METHODS.issuesLinkedPullRequests,
    WS_METHODS.issuesComments,
  ]);
  expect(state.writes).not.toHaveBeenCalled();
});

it("clears continued comments when the detail seed changes and does not call a tail from the old source", async () => {
  const decodeComments = Schema.decodeUnknownSync(IssueCommentsPage);
  let changed = false;
  state.read.mockImplementation((tag, input) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        comments: [nativeComment(changed ? "fresh-seed" : "old-seed", 20)],
        commentsCursor: "same-window",
        events: [
          {
            id: "known-seed",
            kind: "updated",
            actor: null,
            detail: changed ? "fresh partial event" : "old partial event",
            createdAt: "2026-10-15T00:00:00Z",
          },
        ],
        historyTruncated: true,
        capabilities: {
          ...capabilities,
          subIssues: false,
          linkedPullRequests: false,
          events: true,
          historyOrders: [],
        },
      });
    if (tag === WS_METHODS.issuesComments)
      return decodeComments({
        comments: [
          nativeComment(
            changed ? "fresh-page" : input.cursor === "old-tail" ? "old-tail-row" : "old-page",
            10,
          ),
        ],
        nextCursor: changed || input.cursor === "old-tail" ? null : "old-tail",
      });
    throw new Error(`Unexpected RPC ${tag}`);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={reference} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: reference }),
    );
  });
  await act(async () => intersect(container.querySelector('[aria-label="Activity"]')!));
  expect(container.textContent).toContain("old-tail-row");
  changed = true;
  await act(async () =>
    appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: reference })),
  );
  expect(container.textContent).toContain("fresh-seed");
  expect(container.textContent).toContain("fresh-page");
  expect(container.textContent).not.toContain("old-tail-row");
  expect(container.textContent).not.toContain("old-page");
  expect(container.textContent).toContain("fresh partial event");
  expect(container.textContent).not.toContain("old partial event");
  expect(
    state.read.mock.calls
      .filter(([tag]) => tag === WS_METHODS.issuesComments)
      .map(([, input]) => input.cursor),
  ).toEqual(["same-window", "old-tail", "same-window"]);
});

it("keeps comments readable and links the native issue when history orders are empty", async () => {
  state.read.mockImplementation((tag) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        historyTruncated: true,
        comments: [nativeComment("Readable native comment", 10)],
        capabilities: {
          ...capabilities,
          subIssues: false,
          linkedPullRequests: false,
          events: true,
          historyOrders: [],
        },
      });
    if (tag === WS_METHODS.issuesHistory)
      return decodeHistory({
        items: [
          {
            id: "known-history",
            kind: "updated",
            actor: null,
            detail: "Bounded known history event",
            createdAt: "2026-10-15T00:00:00Z",
          },
        ],
        nextCursor: null,
        truncated: true,
      });
    throw new Error(`Unexpected RPC ${tag}`);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={reference} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: reference }),
    );
  });
  expect(container.textContent).toContain("Readable native comment");
  expect(container.textContent).not.toContain("Nothing has happened");
  await act(async () => button("History").click());
  expect(container.textContent).toContain("cannot read the full history");
  expect(
    [...container.querySelectorAll<HTMLAnchorElement>("a")].some(
      (node) => node.textContent?.includes("Open the issue") && node.href === issue.url,
    ),
  ).toBe(true);
  expect(container.textContent).not.toContain("No history yet");
  expect(container.textContent).toContain("Bounded known history event");
  expect(container.textContent).toContain("Their global order is unavailable");
  expect(state.read.mock.calls.map(([tag]) => tag)).toEqual([
    WS_METHODS.issuesDetail,
    WS_METHODS.issuesHistory,
  ]);
  expect(state.read.mock.calls.at(-1)?.[1]).toEqual(reference);
});
const chooseOrder = async (label: string) => {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Activity order"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((element) => element.textContent === label)!
      .click(),
  );
};

it("keeps newest comments on a failed older read and retries without a duplicate detail read", async () => {
  const decodeComments = Schema.decodeUnknownSync(IssueCommentsPage);
  state.failedComments = true;
  state.read.mockImplementation((tag) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        comments: [nativeComment("Latest native comment", 20)],
        commentsCursor: "older",
        capabilities: { ...capabilities, subIssues: false, linkedPullRequests: false },
      });
    if (tag === WS_METHODS.issuesComments)
      return decodeComments({
        comments: [nativeComment("Earlier native comment", 10)],
        nextCursor: null,
      });
    throw new Error(`Unexpected RPC ${tag}`);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={reference} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: reference }),
    );
  });
  expect(container.textContent).toContain("Latest native comment");
  expect(container.textContent).toContain("Native comments unavailable");
  state.failedComments = false;
  await act(async () => button("Retry").click());
  expect(container.textContent).toContain("Latest native comment");
  expect(container.textContent).toContain("Earlier native comment");
  expect(container.textContent).not.toContain("Native comments unavailable");
  expect(state.read.mock.calls.map(([tag]) => tag)).toEqual([
    WS_METHODS.issuesDetail,
    WS_METHODS.issuesComments,
    WS_METHODS.issuesComments,
  ]);
  expect(state.writes).not.toHaveBeenCalled();
});

it.each([
  { name: "legacy", commentOrders: undefined, historyOrders: undefined, order: "desc" },
  { name: "comments asc only", commentOrders: ["asc"], historyOrders: undefined, order: "asc" },
  { name: "history asc only", commentOrders: undefined, historyOrders: ["asc"], order: "asc" },
  { name: "no history", commentOrders: undefined, historyOrders: [], order: "desc" },
  { name: "no history with asc comments", commentOrders: ["asc"], historyOrders: [], order: "asc" },
  { name: "disjoint native orders", commentOrders: ["asc"], historyOrders: ["desc"], order: "asc" },
] as const)(
  "uses a real native activity window for $name",
  async ({ commentOrders, historyOrders, order }) => {
    const nativeRef = { ...reference, connectionId: "Account-B" };
    const decodeComments = Schema.decodeUnknownSync(IssueCommentsPage);
    state.read.mockImplementation((tag) => {
      if (tag === WS_METHODS.issuesDetail)
        return decodeDetail({
          ...issue,
          ...nativeRef,
          comments: [nativeComment("seed-newest", 20)],
          commentsCursor: "native-older",
          events: [
            {
              id: "native-event",
              kind: "updated",
              detail: "native change",
              actor: null,
              createdAt: "2026-10-15T00:00:00Z",
            },
          ],
          historyTruncated: historyOrders?.length === 0,
          capabilities: {
            ...capabilities,
            linkedPullRequests: false,
            subIssues: false,
            events: true,
            commentOrders,
            historyOrders,
          },
        });
      if (tag === WS_METHODS.issuesComments)
        return decodeComments({
          comments: [nativeComment(order === "asc" ? "oldest" : "older", order === "asc" ? 1 : 10)],
          nextCursor: null,
        });
      throw new Error(`Unexpected RPC ${tag}`);
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: nativeRef }),
      );
    });
    const reads = state.read.mock.calls.filter(([tag]) => tag === WS_METHODS.issuesComments);
    expect(reads.map(([, input]) => input)).toEqual([
      {
        ...nativeRef,
        order,
        viewer: "viewer",
        ...(order === "desc" ? { cursor: "native-older" } : {}),
      },
    ]);
    const activity = container.querySelector('[aria-label="Activity"]')!;
    expect([...activity.querySelectorAll("article")].map((node) => node.textContent)).toEqual(
      order === "desc"
        ? [expect.stringContaining("seed-newest"), expect.stringContaining("older")]
        : [expect.stringContaining("oldest")],
    );
    const partialHistory = historyOrders?.length === 0;
    const disjointOrders = commentOrders?.[0] === "asc" && historyOrders?.[0] === "desc";
    expect(activity.textContent?.includes("native change")).toBe(!disjointOrders);
    if (partialHistory) {
      expect(activity.textContent).toContain(
        "History is incomplete and its global order is unavailable",
      );
      expect(activity.textContent).toContain("Comment order");
      expect(activity.textContent).not.toContain("Activity history is not available in this order");
      expect(activity.textContent).not.toContain("Some activity is not shown here");
      expect([...activity.querySelectorAll("a")].map((node) => node.href)).toEqual([issue.url]);
      expect(activity.textContent).not.toContain("Nothing has happened");
    }
    if (disjointOrders) {
      expect(activity.textContent).toContain("Activity history is not available in this order");
      expect(activity.querySelector<HTMLAnchorElement>("a")?.href).toBe(issue.url);
      expect(activity.textContent).not.toContain("Nothing has happened");
    }
    if (order === "asc") {
      expect(activity.textContent).toContain("oldest first only");
      await act(async () =>
        activity
          .querySelector<HTMLButtonElement>('[aria-label="Activity order"]')!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
      );
      const newest = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (node) => node.textContent === "Newest first",
      )!;
      expect(newest.getAttribute("aria-disabled")).toBe("true");
      await act(async () => newest.click());
      expect(
        state.read.mock.calls.filter(([tag]) => tag === WS_METHODS.issuesComments),
      ).toHaveLength(1);
    }
    expect(state.writes).not.toHaveBeenCalled();
  },
);

it("starts oldest comments without a cursor, drops a stale newest tail, and keeps the draft on order and refresh", async () => {
  const nativeRef = { ...reference, connectionId: "Account-B" };
  const decodeComments = Schema.decodeUnknownSync(IssueCommentsPage);
  let finish!: (value: unknown) => void;
  state.read.mockImplementation((tag, input) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        ...nativeRef,
        comments: [nativeComment("seed-newest", 20)],
        commentsCursor: "older",
        events: [
          {
            id: "known-seed",
            kind: "updated",
            actor: null,
            detail: "Known partial native event",
            createdAt: "2026-10-15T00:00:00Z",
            url: "https://gitlab.example/native/event/known",
          },
        ],
        historyTruncated: true,
        capabilities: {
          ...capabilities,
          comment: true,
          linkedPullRequests: false,
          subIssues: false,
          events: true,
          historyOrders: [],
        },
        viewerPermissions: { ...issue.viewerPermissions, comment: true },
      });
    if (tag === WS_METHODS.issuesComments) {
      if (input.cursor === "newest-tail")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return decodeComments({
        comments: [
          nativeComment(input.order === "asc" ? "oldest" : "older", input.order === "asc" ? 1 : 10),
        ],
        nextCursor: input.order === "asc" ? "oldest-tail" : "newest-tail",
      });
    }
    throw new Error(`Unexpected RPC ${tag}`);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: nativeRef }),
    );
  });
  const draft = container.querySelector<HTMLTextAreaElement>('[aria-label="Add a comment"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      draft,
      "Keep my draft",
    );
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => intersect(container.querySelector('[aria-label="Activity"]')!));
  expect(typeof finish).toBe("function");
  await chooseOrder("Oldest first");
  await act(async () =>
    finish(decodeComments({ comments: [nativeComment("stale-tail", 2)], nextCursor: null })),
  );
  expect(container.textContent).toContain("oldest");
  expect(container.textContent).not.toContain("stale-tail");
  expect(container.textContent).not.toContain("seed-newest");
  expect(draft.value).toBe("Keep my draft");
  expect(container.textContent).toContain("Known partial native event");
  expect(container.textContent).toContain(
    "History is incomplete and its global order is unavailable",
  );
  expect(
    container.querySelector<HTMLAnchorElement>(
      'a[href="https://gitlab.example/native/event/known"]',
    )?.href,
  ).toBe("https://gitlab.example/native/event/known");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh issue"]')!.click(),
  );
  expect(draft.value).toBe("Keep my draft");
  expect(container.textContent).toContain("Known partial native event");
  const inputs = state.read.mock.calls
    .filter(([tag]) => tag === WS_METHODS.issuesComments)
    .map(([, input]) => input);
  expect(inputs).toEqual([
    { ...nativeRef, order: "desc", viewer: "viewer", cursor: "older" },
    { ...nativeRef, order: "desc", viewer: "viewer", cursor: "newest-tail" },
    { ...nativeRef, order: "asc", viewer: "viewer" },
    { ...nativeRef, order: "asc", viewer: "viewer" },
  ]);
  expect(state.writes).not.toHaveBeenCalled();
});

it.each(["viewer", null])(
  "keeps same-viewer pages but fences a fresh unknown-viewer seed (%s)",
  async (viewer) => {
    const nativeRef = { ...reference, connectionId: "Account-B" };
    const decodeComments = Schema.decodeUnknownSync(IssueCommentsPage);
    let changed = false;
    let finish!: () => void;
    const page = (current: boolean) =>
      decodeComments({
        comments: [
          {
            ...nativeComment("Older owned comment", 10),
            canEdit: current,
            reactions: [{ content: "thumbs-up", count: 1, actors: [], viewerHasReacted: current }],
          },
        ],
        nextCursor: null,
      });
    state.read.mockImplementation((tag) => {
      if (tag === WS_METHODS.issuesDetail)
        return decodeDetail({
          ...issue,
          ...nativeRef,
          viewer,
          comments: [
            {
              ...nativeComment("same-seed", 20),
              body: changed ? "Refreshed seed" : "Original seed",
            },
          ],
          commentsCursor: "older",
          capabilities: {
            ...capabilities,
            subIssues: false,
            linkedPullRequests: false,
            editComment: true,
          },
        });
      if (tag === WS_METHODS.issuesComments) {
        if (changed && viewer === null)
          return new Promise((resolve) => {
            finish = () => resolve(page(false));
          });
        return page(true);
      }
      throw new Error(`Unexpected RPC ${tag}`);
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
        </RegistryContext.Provider>,
      ),
    );
    await act(async () => {
      await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: nativeRef }),
      );
    });
    const older = () =>
      [...container.querySelectorAll("article")].find((node) =>
        node.textContent?.includes("Older owned comment"),
      );
    expect(older()?.querySelector('[aria-label="Edit comment"]')).not.toBeNull();
    expect(older()?.querySelector('[aria-label^="thumbs up,"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    changed = true;
    await act(async () =>
      appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: nativeRef })),
    );
    expect(container.textContent).toContain("Refreshed seed");
    const reads = state.read.mock.calls.filter(([tag]) => tag === WS_METHODS.issuesComments);
    expect(reads).toHaveLength(viewer === null ? 2 : 1);
    if (viewer === null) {
      expect(older()).toBeUndefined();
      expect(typeof finish).toBe("function");
      await act(async () => finish());
      expect(older()?.querySelector('[aria-label="Edit comment"]')).toBeNull();
      expect(
        older()?.querySelector('[aria-label^="thumbs up,"]')?.getAttribute("aria-pressed"),
      ).toBe("false");
    } else {
      expect(older()?.querySelector('[aria-label="Edit comment"]')).not.toBeNull();
      expect(
        older()?.querySelector('[aria-label^="thumbs up,"]')?.getAttribute("aria-pressed"),
      ).toBe("true");
    }
    for (const [, input] of reads)
      expect(input).toEqual({
        ...nativeRef,
        order: "desc",
        cursor: "older",
        ...(viewer === null ? {} : { viewer }),
      });
    expect(state.writes).not.toHaveBeenCalled();
  },
);

it("restarts a shifted Jira seed at the same cursor and reads every boundary comment once", async () => {
  const nativeRef = {
    ...reference,
    tracker: IssueTrackerKind.make("jira"),
    host: "workspace.atlassian.net",
    scope: "ENG",
    key: "ENG-1",
    connectionId: "Account-B",
  };
  const decodeComments = Schema.decodeUnknownSync(IssueCommentsPage);
  let shifted = false;
  const comments = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => {
      const number = from + index;
      return {
        id: String(number),
        body: `Comment ${number}`,
        author: null,
        url: null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(),
      };
    });
  state.read.mockImplementation((tag, input) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        ...nativeRef,
        comments: comments(shifted ? 102 : 101, shifted ? 151 : 150),
        commentsCursor: "50",
        capabilities: { ...capabilities, linkedPullRequests: false, subIssues: false },
      });
    if (tag === WS_METHODS.issuesComments) {
      const offset = Number(input.cursor);
      return decodeComments({
        comments: !shifted
          ? comments(51, 100)
          : offset === 50
            ? comments(52, 102)
            : offset === 100
              ? comments(2, 52)
              : comments(1, 2),
        nextCursor: !shifted || offset === 50 ? "100" : offset === 100 ? "150" : null,
      });
    }
    throw new Error(`Unexpected RPC ${tag}`);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={nativeRef} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: nativeRef }),
    );
  });
  expect(container.querySelectorAll("article")).toHaveLength(100);
  shifted = true;
  await act(async () =>
    appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: nativeRef })),
  );
  expect(container.querySelectorAll("article")).toHaveLength(100);
  expect(container.textContent).not.toMatch(/Comment 51\D/);
  await act(async () => intersect(container.querySelector('[aria-label="Activity"]')!));
  await act(async () => intersect(container.querySelector('[aria-label="Activity"]')!));
  const ids = [...container.querySelectorAll("article")].map(
    (node) => node.textContent?.match(/Comment (\d+)/)?.[1],
  );
  expect(ids).toEqual(Array.from({ length: 151 }, (_, index) => String(151 - index)));
  expect(
    state.read.mock.calls
      .filter(([tag]) => tag === WS_METHODS.issuesComments)
      .map(([, input]) => input.cursor),
  ).toEqual(["50", "50", "100", "150"]);
  expect(observers.size).toBe(0);
  expect(state.writes).not.toHaveBeenCalled();
});

it("keeps a saved older-comment edit through a stale detail read and reopening the editor", async () => {
  const decodeComments = Schema.decodeUnknownSync(IssueCommentsPage);
  state.read.mockImplementation((tag) => {
    if (tag === WS_METHODS.issuesDetail)
      return decodeDetail({
        ...issue,
        comments: [nativeComment("Latest comment", 20)],
        commentsCursor: "older",
        capabilities: {
          ...capabilities,
          linkedPullRequests: false,
          subIssues: false,
          editComment: true,
        },
      });
    if (tag === WS_METHODS.issuesComments)
      return decodeComments({
        comments: [{ ...nativeComment("Before older edit", 10), canEdit: true }],
        nextCursor: null,
      });
    throw new Error(`Unexpected RPC ${tag}`);
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueDetailPanel environmentId={environmentId} reference={reference} />
      </RegistryContext.Provider>,
    ),
  );
  await act(async () => {
    await executeAtomQuery(
      appAtomRegistry,
      issueEnvironment.detail({ environmentId, input: reference }),
    );
  });
  const edit = () =>
    [...container.querySelectorAll("article")]
      .find((node) => node.textContent?.includes("older edit"))!
      .querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!;
  await act(async () => edit().click());
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit comment"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "After older edit",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  expect(state.writes).toHaveBeenCalledExactlyOnceWith(WS_METHODS.issuesEditComment, {
    ...reference,
    commentId: "Before older edit",
    body: "After older edit",
  });
  await act(async () =>
    appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: reference })),
  );
  expect(container.querySelector('textarea[aria-label="Edit comment"]')).toBeNull();
  expect(container.textContent).toContain("After older edit");
  expect(container.textContent).not.toContain("Before older edit");
  await act(async () => edit().click());
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]')?.value,
  ).toBe("After older edit");
});
