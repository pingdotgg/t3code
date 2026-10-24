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

vi.mock("../../state/pull-requests", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
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
      target.environmentId === "offline"
        ? AsyncResult.failure(Cause.fail(new Error("Environment is not connected.")))
        : AsyncResult.success(response),
    );
  });
  return {
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

it("keeps a refresh failure in the source errors and allows healthy pagination", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const targets = ["healthy", "offline"].map((id) => ({
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
  try {
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      );
    });
    await act(async () => latest.onRefresh());
    expect(latest!.data.errors.map((error) => error.message)).toEqual([
      "Environment is not connected.",
    ]);
    expect(latest!.refreshing).toBe(false);
    expect(latest!.loadMoreError).toBeNull();

    await act(async () => latest.loadMore());
    expect(latest!.continued).toBe(true);
    expect(latest!.hasMore).toBe(false);
    expect(latest!.loadMoreError).toBeNull();
  } finally {
    act(() => root.unmount());
    registry.dispose();
  }
});
