import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, IssueTrackerKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement, useEffect } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("@t3tools/client-runtime/state/issues", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const pages = Atom.family((_key: string) => {
    const value = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(
      AsyncResult.success({ items: [], nextCursor: null }),
    ).pipe(Atom.keepAlive);
    return Atom.writable(
      (get) => get(value),
      (get, result: AsyncResult.AsyncResult<unknown, unknown>) => get.set(value, result),
      () => undefined,
    ).pipe(Atom.keepAlive);
  });
  const family = (target: unknown) => pages(JSON.stringify(target));
  return {
    createIssueEnvironmentAtoms: () => ({
      history: family,
      linkedPullRequests: family,
      hierarchy: family,
      labelCandidates: family,
      assigneeCandidates: family,
      dependencies: family,
    }),
  };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  issueEnvironment,
  useIssueHistory,
  useIssueDependencies,
  type IssuePagedView,
} from "./issues";
import type {
  IssueDependenciesInput,
  IssueDependenciesPage,
  IssueEvent,
  IssueHistoryPage,
} from "@t3tools/contracts";

const environmentId = EnvironmentId.make("environment");
const input = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("jira"),
  host: "jira.example",
  scope: "ENG",
  key: "ENG-1",
};
const event = (id: string): IssueEvent => ({
  id,
  kind: "changed",
  actor: null,
  createdAt: "2026-10-14T00:00:00Z",
  detail: id,
});
let root: ReactTestRenderer | undefined;
let view: IssuePagedView<IssueEvent>;
function Probe() {
  const current = useIssueHistory(environmentId, input);
  useEffect(() => {
    view = current;
  }, [current]);
  return null;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});

it("drops retained pages when the native first page changes with the same cursor", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = issueEnvironment.history({ environmentId, input }) as Atom.Writable<
    AsyncResult.AsyncResult<IssueHistoryPage, unknown>
  >;
  const second = issueEnvironment.history({
    environmentId,
    input: { ...input, cursor: "next" },
  }) as Atom.Writable<AsyncResult.AsyncResult<IssueHistoryPage, unknown>>;
  appAtomRegistry.set(first, AsyncResult.success({ items: [event("newest")], nextCursor: "next" }));
  appAtomRegistry.set(second, AsyncResult.success({ items: [event("older")], nextCursor: "next" }));
  await act(async () => {
    root = create(
      createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
    );
  });
  await act(async () => view.loadMore());
  expect(view.items.map((item) => item.id)).toEqual(["newest", "older"]);
  expect(view.hasMore).toBe(false);
  await act(async () => view.loadMore());
  expect(view.items).toHaveLength(2);
  await act(async () => {
    appAtomRegistry.set(
      first,
      AsyncResult.success({ items: [event("replacement")], nextCursor: "next" }),
    );
  });
  expect(view.items.map((item) => item.id)).toEqual(["replacement"]);
  expect(view.hasMore).toBe(true);
});

it("refreshes only the first history page while older pages are held", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = issueEnvironment.history({ environmentId, input }) as Atom.Writable<
    AsyncResult.AsyncResult<IssueHistoryPage, unknown>
  >;
  const next = issueEnvironment.history({
    environmentId,
    input: { ...input, cursor: "refresh-tail" },
  }) as Atom.Writable<AsyncResult.AsyncResult<IssueHistoryPage, unknown>>;
  appAtomRegistry.set(
    first,
    AsyncResult.success({ items: [event("first")], nextCursor: "refresh-tail" }),
  );
  appAtomRegistry.set(next, AsyncResult.success({ items: [event("tail")], nextCursor: null }));
  await act(async () => {
    root = create(
      createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
    );
  });
  await act(async () => view.loadMore());
  expect(view.items.map((item) => item.id)).toEqual(["first", "tail"]);
  const refresh = vi.spyOn(appAtomRegistry, "refresh");
  try {
    await act(async () => view.refresh());
    expect(refresh).toHaveBeenCalledExactlyOnceWith(first);
  } finally {
    refresh.mockRestore();
  }
});

it("keeps a failed continuation available for retry without dropping earlier items", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = issueEnvironment.history({ environmentId, input }) as Atom.Writable<
    AsyncResult.AsyncResult<IssueHistoryPage, unknown>
  >;
  const second = issueEnvironment.history({
    environmentId,
    input: { ...input, cursor: "retry" },
  }) as Atom.Writable<AsyncResult.AsyncResult<IssueHistoryPage, unknown>>;
  appAtomRegistry.set(first, AsyncResult.success({ items: [event("first")], nextCursor: "retry" }));
  appAtomRegistry.set(second, AsyncResult.failure(Cause.fail("offline")));
  await act(async () => {
    root = create(
      createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
    );
  });
  await act(async () => view.loadMore());
  expect(view.items.map((item) => item.id)).toEqual(["first"]);
  expect(view.hasMore).toBe(true);
  const refresh = vi.spyOn(appAtomRegistry, "refresh");
  try {
    await act(async () => view.loadMore());
    expect(refresh).toHaveBeenCalledExactlyOnceWith(second);
    await act(async () =>
      appAtomRegistry.set(
        second,
        AsyncResult.success({ items: [event("recovered")], nextCursor: null }),
      ),
    );
    expect(view.items.map((item) => item.id)).toEqual(["first", "recovered"]);
    expect(view.hasMore).toBe(false);
  } finally {
    refresh.mockRestore();
  }
});

it.each(["blocks", "blocked-by"] as const)(
  "accumulates and deduplicates %s pages, resets refresh and input identity, and guards cursor loops",
  async (direction) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let target: IssueDependenciesInput = { ...input, direction, limit: 100 };
    let environment = environmentId;
    let dependencies!: IssuePagedView<IssueDependenciesPage["items"][number]>;
    const relation = (key: string, kind: "issue" | "pull-request" = "issue") => ({
      scope: input.scope,
      key,
      displayKey: key,
      title: key,
      kind,
      url: `https://jira.example/${key}`,
      state: { category: "open" as const, name: "open" },
    });
    const firstItems = Array.from({ length: 50 }, (_, index) => relation(String(index)));
    const atom = (cursor?: string) =>
      issueEnvironment.dependencies({
        environmentId: environment,
        input: cursor === undefined ? target : { ...target, cursor },
      }) as Atom.Writable<AsyncResult.AsyncResult<IssueDependenciesPage, unknown>>;
    const first = atom();
    const tail = atom("tail");
    const last = atom("last");
    appAtomRegistry.set(
      first,
      AsyncResult.success({ items: firstItems, nextCursor: "tail", truncated: true }),
    );
    appAtomRegistry.set(
      tail,
      AsyncResult.success({
        items: [relation("49"), relation("50"), relation("50", "pull-request")],
        nextCursor: "last",
      }),
    );
    appAtomRegistry.set(last, AsyncResult.success({ items: [relation("51")], nextCursor: "tail" }));
    function DependenciesProbe() {
      const current = useIssueDependencies(environment, target);
      useEffect(() => {
        dependencies = current;
      }, [current]);
      return null;
    }
    const render = () =>
      createElement(
        RegistryContext.Provider,
        { value: appAtomRegistry },
        createElement(DependenciesProbe),
      );
    await act(async () => {
      root = create(render());
    });
    await act(async () => dependencies.loadMore());
    expect(dependencies.items).toEqual([
      ...firstItems,
      relation("50"),
      relation("50", "pull-request"),
    ]);
    expect(dependencies.truncated).toBe(true);
    await act(async () => appAtomRegistry.set(tail, AsyncResult.failure(Cause.fail("offline"))));
    expect(dependencies.items).toEqual(firstItems);
    expect(dependencies.error).not.toBeNull();
    expect(dependencies.hasMore).toBe(true);
    await act(async () =>
      appAtomRegistry.set(
        tail,
        AsyncResult.success({
          items: [relation("49"), relation("50"), relation("50", "pull-request")],
          nextCursor: "last",
        }),
      ),
    );
    await act(async () => dependencies.loadMore());
    expect(dependencies.items).toHaveLength(53);
    expect(dependencies.hasMore).toBe(false);
    await act(async () => dependencies.loadMore());
    expect(dependencies.items).toHaveLength(53);
    const refresh = vi.spyOn(appAtomRegistry, "refresh");
    try {
      await act(async () => dependencies.refresh());
      expect(refresh).toHaveBeenCalledExactlyOnceWith(first);
      expect(dependencies.items).toEqual(firstItems);
      await act(async () => appAtomRegistry.set(first, AsyncResult.failure(Cause.fail("offline"))));
      expect(dependencies.error).toBe("The environment request failed.");
      expect(dependencies.items).toEqual([]);
      expect(dependencies.hasMore).toBe(false);
      await act(async () =>
        appAtomRegistry.set(first, AsyncResult.success({ items: firstItems, nextCursor: "tail" })),
      );
      await act(async () => dependencies.loadMore());
      const targets = [
        { ...target, key: "ENG-2" },
        { ...target, connectionId: "Account-B" },
        {
          ...target,
          direction: direction === "blocks" ? ("blocked-by" as const) : ("blocks" as const),
        },
      ];
      for (const next of targets) {
        target = next;
        appAtomRegistry.set(
          atom(),
          AsyncResult.success({ items: [relation("new")], nextCursor: "tail" }),
        );
        appAtomRegistry.set(
          atom("tail"),
          AsyncResult.success({ items: [relation("new-tail")], nextCursor: null }),
        );
        await act(async () => root!.update(render()));
        expect(dependencies.items).toEqual([relation("new")]);
        expect(dependencies.error).toBeNull();
        await act(async () => dependencies.loadMore());
        expect(dependencies.items).toEqual([relation("new"), relation("new-tail")]);
      }
      environment = EnvironmentId.make("other-environment");
      appAtomRegistry.set(
        atom(),
        AsyncResult.success({ items: [relation("other")], nextCursor: null }),
      );
      await act(async () => root!.update(render()));
      expect(dependencies.items).toEqual([relation("other")]);
    } finally {
      refresh.mockRestore();
    }
  },
);
