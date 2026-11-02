import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type PullRequestListInput,
  type PullRequestListResult,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ failPage: false }));

vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      sessionGenerationAtom: Atom.family((_environmentId: string) => Atom.make(0)),
    },
  };
});

vi.mock("../../state/pull-requests", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const page = (nextCursors: PullRequestListResult["nextCursors"]): PullRequestListResult => ({
    entries: [],
    nextCursors,
    truncated: false,
    viewers: {},
    providers: [],
    errors: [],
  });
  const list = Atom.family((key: string) => {
    const target: { environmentId: string; input: PullRequestListInput } = JSON.parse(key);
    const response = page(target.input.cursors ? {} : { "github.com org/repo": "next" });
    return Atom.make(
      Effect.suspend(() => {
        if (target.environmentId === "offline")
          return Effect.fail(new Error("Environment is not connected."));
        if (target.input.cursors && mocks.failPage) return Effect.fail(new Error("Page failed."));
        return Effect.succeed(response);
      }),
    );
  });
  const { pullRequestListHead } = await import("./pullRequestList");
  const pages = Atom.family((_key: string) =>
    Atom.make<ReturnType<typeof pullRequestListHead> | null>(null),
  );
  return {
    pullRequestListPagesKey: (target: unknown) => JSON.stringify(target),
    pullRequestListPagesFamily: pages,
    pullRequestListStatsFamily: Atom.family((_key: string) => Atom.make(new Map())),
    composerPullRequests: {
      list: (target: unknown) => list(JSON.stringify(target)),
      listStats: Atom.family(() => Atom.make(AsyncResult.success({ stats: [] }))),
      invalidate: {
        run: async () => AsyncResult.success({}),
      },
    },
  };
});

import { usePullRequestList } from "./usePullRequestList";

function setup(ids: readonly string[]) {
  mocks.failPage = false;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const targets = ids.map((id) => ({
    environmentId: EnvironmentId.make(id),
    input: { state: "open" as const },
  }));
  let latest: ReturnType<typeof usePullRequestList>;
  function Probe() {
    const result = usePullRequestList(targets);
    useLayoutEffect(() => {
      latest = result;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    );
  });
  return {
    get latest() {
      return latest;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("keeps a refresh failure in the source errors and allows healthy pagination", async () => {
  using probe = setup(["healthy", "offline"]);
  await act(async () => probe.latest.onRefresh());
  expect(probe.latest.data.errors.map((error) => error.message)).toEqual([
    "Environment is not connected.",
  ]);
  expect(probe.latest.refreshing).toBe(false);
  expect(probe.latest.loadMoreError).toBeNull();

  await act(async () => probe.latest.loadMore());
  expect(probe.latest.continued).toBe(true);
  expect(probe.latest.hasMore).toBe(false);
  expect(probe.latest.loadMoreError).toBeNull();
});

it("keeps load-more failures retryable", async () => {
  using probe = setup(["healthy"]);
  await act(async () => probe.latest.onRefresh());
  mocks.failPage = true;
  await act(async () => probe.latest.loadMore());
  expect(probe.latest.loadMoreError).toBe("Page failed.");
  expect(probe.latest.hasMore).toBe(true);
  expect(probe.latest.continued).toBe(false);

  mocks.failPage = false;
  await act(async () => probe.latest.loadMore(true));
  expect(probe.latest.loadMoreError).toBeNull();
  expect(probe.latest.hasMore).toBe(false);
  expect(probe.latest.continued).toBe(true);
});
