import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerPathSearch } from "./queries";

const requests = vi.hoisted(() => ({
  search: vi.fn(
    (target: { environmentId: string; input: { cwd: string; query: string } }) => target,
  ),
}));
vi.mock("./projects", () => ({
  projectEnvironment: { searchEntries: requests.search },
  projectContentSearch: vi.fn(),
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: (target: { input: { query: string } } | null) => ({
    data: target ? { entries: [{ path: `${target.input.query}.ts`, kind: "file" }] } : null,
    error: null,
    isPending: false,
  }),
}));

const target = { environmentId: EnvironmentId.make("local"), cwd: "/worktree-a" };
let renderer: ReactTestRenderer;
let latest: ReturnType<typeof useComposerPathSearch>;

function Probe({
  query,
  cwd = target.cwd,
  environmentId = target.environmentId,
}: {
  query: string | null;
  cwd?: string;
  environmentId?: EnvironmentId;
}) {
  const result = useComposerPathSearch({ environmentId, cwd, query });
  useLayoutEffect(() => {
    latest = result;
  }, [result]);
  return null;
}

async function type(query: string | null) {
  await act(() => renderer.update(<Probe query={query} />));
}
async function advance(ms: number) {
  await act(() => vi.advanceTimersByTime(ms));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  requests.search.mockClear();
  await act(() => {
    renderer = create(<Probe query={null} />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("composer path search scheduling", () => {
  it("shows the first query without waiting for a typing pause", async () => {
    await type("r");
    expect(latest.entries).toEqual([{ path: "r.ts", kind: "file" }]);
    expect(latest.isPending).toBe(false);
  });

  it("updates results during continuous typing and eventually searches the final query", async () => {
    await type("r");
    await advance(80);
    await type("re");
    await advance(80);
    await type("rea");
    await advance(80);
    expect(requests.search.mock.calls.some(([request]) => request.input.query === "re")).toBe(true);
    await type("read");
    await advance(120);
    expect(latest.entries).toEqual([{ path: "read.ts", kind: "file" }]);
    expect(latest.isPending).toBe(false);
  });

  it("coalesces a burst instead of requesting every keystroke", async () => {
    await type("r");
    for (const query of ["re", "rea", "read", "readm", "readme"]) {
      await advance(10);
      await type(query);
    }
    const uniqueQueries = () =>
      new Set(requests.search.mock.calls.map(([request]) => request.input.query));
    expect(uniqueQueries().size).toBeLessThanOrEqual(2);
    await advance(120);
    expect(latest.entries).toEqual([{ path: "readme.ts", kind: "file" }]);
  });
  it("clears results immediately when the mention closes, including pending trailing work", async () => {
    await type("r");
    await advance(10);
    await type("readme");
    await type(null);
    expect(latest.entries).toEqual([]);
    expect(latest.isPending).toBe(false);
    requests.search.mockClear();
    await advance(120);
    expect(latest.entries).toEqual([]);
    expect(requests.search).not.toHaveBeenCalled();
  });

  it.each([
    { cwd: "/worktree-b", environmentId: target.environmentId },
    { cwd: target.cwd, environmentId: EnvironmentId.make("remote") },
  ])("does not expose the previous workspace while switching to %s", async (scope) => {
    await type("r");
    await advance(10);
    requests.search.mockClear();
    await act(() => renderer.update(<Probe query="r" {...scope} />));
    expect(latest.entries).toEqual([]);
    expect(requests.search).not.toHaveBeenCalled();
    await advance(120);
    expect(requests.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId: scope.environmentId,
        input: expect.objectContaining({ cwd: scope.cwd, query: "r" }),
      }),
    );
    expect(latest.isPending).toBe(false);
  });

  it("starts a new query immediately after an idle period", async () => {
    await type("r");
    await advance(500);
    await type("readme");
    expect(latest.entries).toEqual([{ path: "readme.ts", kind: "file" }]);
    expect(latest.isPending).toBe(false);
  });
});
