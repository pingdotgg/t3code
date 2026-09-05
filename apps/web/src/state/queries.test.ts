import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { act, createElement, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  areProjectPathSearchTargetsEqual,
  useComposerPathSearch,
  useProjectPathSearch,
} from "./queries";

type SearchRequest = { environmentId: EnvironmentId; input: ProjectSearchEntriesInput };
const requests = vi.hoisted(() => ({
  started: [] as SearchRequest[],
  pending: [] as { target: SearchRequest; resolve: (result: ProjectSearchEntriesResult) => void }[],
}));

// Replace the environment I/O boundary, retaining real query atoms, React
// subscriptions and debounce behavior. Requests begin when their atom runs.
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const { EnvironmentId, ProjectSearchEntriesInput } = await import("@t3tools/contracts");
  const Effect = await import("effect/Effect");
  const Schema = await import("effect/Schema");
  const codec = Schema.fromJsonString(
    Schema.Struct({ environmentId: EnvironmentId, input: ProjectSearchEntriesInput }),
  );
  const family = Atom.family((key: string) => {
    const target = Schema.decodeUnknownSync(codec)(key);
    return Atom.make(
      Effect.promise(() => {
        requests.started.push(target);
        return new Promise<ProjectSearchEntriesResult>((resolve) => {
          requests.pending.push({ target, resolve });
        });
      }),
    );
  });
  return {
    projectEnvironment: {
      searchEntries: (target: SearchRequest) => family(Schema.encodeSync(codec)(target)),
    },
    projectContentSearch: vi.fn(),
  };
});

describe("areProjectPathSearchTargetsEqual", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-a"),
    cwd: "/project-a",
    query: "index",
  };

  it("requires the environment, workspace, query, entry kind, and image filter to match", () => {
    expect(areProjectPathSearchTargetsEqual(target, target)).toBe(true);
    expect(
      areProjectPathSearchTargetsEqual(target, {
        ...target,
        environmentId: EnvironmentId.make("environment-b"),
      }),
    ).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, cwd: "/project-b" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, query: "readme" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, kind: "file" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, imageOnly: true })).toBe(false);
  });
});

describe("composer path search execution", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-a"),
    cwd: "/project-a",
    query: "",
  };
  let renderer: ReactTestRenderer | undefined;
  let registry: AtomRegistry.AtomRegistry;
  let latest: ReturnType<typeof useComposerPathSearch>;

  function ComposerProbe({ value }: { value: Parameters<typeof useComposerPathSearch>[0] }) {
    const state = useComposerPathSearch(value);
    useLayoutEffect(() => {
      latest = state;
    }, [state]);
    return null;
  }

  function OtherSearchProbe({ value }: { value: Parameters<typeof useComposerPathSearch>[0] }) {
    const state = useProjectPathSearch(value, 12);
    useLayoutEffect(() => {
      latest = state;
    }, [state]);
    return null;
  }

  async function render(
    value: Parameters<typeof useComposerPathSearch>[0],
    mode: "composer" | "other" = "composer",
  ) {
    await act(() => {
      const node = createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(mode === "composer" ? ComposerProbe : OtherSearchProbe, { value }),
      );
      if (renderer) renderer.update(node);
      else renderer = create(node);
    });
  }

  async function advance(milliseconds: number) {
    await act(() => vi.advanceTimersByTimeAsync(milliseconds));
  }

  async function completeNext(entries: ProjectSearchEntriesResult["entries"]) {
    const pending = requests.pending.shift();
    if (!pending) throw new Error("Expected a started project search");
    await act(() => pending.resolve({ entries, truncated: false }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    registry = AtomRegistry.make();
    renderer = undefined;
    requests.started = [];
    requests.pending = [];
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    registry.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["", "   "])(
    "executes an initial bounded browse for query %j and reports pending results",
    async (query) => {
      await render({ ...target, query });
      expect(requests.started).toEqual([
        { environmentId: target.environmentId, input: { cwd: target.cwd, query: "", limit: 80 } },
      ]);
      expect(latest.isPending).toBe(true);
      expect(latest.entries).toEqual([]);
      const entries = Array.from({ length: 80 }, (_, index) => ({
        path: `file-${index}.ts`,
        kind: "file" as const,
      }));
      await completeNext(entries);
      expect(latest.isPending).toBe(false);
      expect(latest.entries).toEqual(entries);
    },
  );

  it.each([{ query: null }, { environmentId: null }, { cwd: null }])(
    "does not search an incomplete target: %j",
    async (missing) => {
      await render({ ...target, ...missing });
      await advance(120);
      expect(requests.started).toEqual([]);
      expect(latest.isPending).toBe(false);
    },
  );

  it("starts browsing after an inactive trigger becomes empty and ignores results after dismissal", async () => {
    await render({ ...target, query: null });
    await render(target);
    expect(latest.isPending).toBe(true);
    await advance(119);
    expect(requests.started).toEqual([]);
    await advance(1);
    expect(requests.started).toHaveLength(1);
    expect(requests.started[0]?.input.query).toBe("");
    await render({ ...target, query: null });
    await advance(120);
    await completeNext([{ path: "late-browse-result.txt", kind: "file" }]);
    expect(latest.entries).toEqual([]);
    expect(latest.isPending).toBe(false);
  });

  it("keeps other path searches opt-in and preserves their result limit", async () => {
    await render(target, "other");
    expect(requests.started).toEqual([]);
    await render({ ...target, query: " README " }, "other");
    expect(latest.isPending).toBe(true);
    await advance(119);
    expect(requests.started).toEqual([]);
    await advance(1);
    expect(requests.started).toEqual([
      {
        environmentId: target.environmentId,
        input: { cwd: target.cwd, query: "README", limit: 12 },
      },
    ]);
    await completeNext([{ path: "README.md", kind: "file" }]);
    expect(latest.entries).toEqual([{ path: "README.md", kind: "file" }]);
  });

  it("debounces nonempty changes and retains a genuine empty result", async () => {
    await render(target);
    await completeNext([{ path: "README.md", kind: "file" }]);
    await render({ ...target, query: "README" });
    expect(latest.isPending).toBe(true);
    await advance(119);
    expect(requests.started).toHaveLength(1);
    await render({ ...target, query: "ZZZZ" });
    await advance(119);
    expect(requests.started).toHaveLength(1);
    await advance(1);
    expect(requests.started.at(-1)?.input.query).toBe("ZZZZ");
    expect(latest.isPending).toBe(true);
    await completeNext([]);
    expect(latest.entries).toEqual([]);
    expect(latest.isPending).toBe(false);
    expect(latest.searchedQuery).toBe("ZZZZ");
  });

  it("switches environments without accepting a late response from the previous target", async () => {
    await render(target);
    const next = {
      ...target,
      environmentId: EnvironmentId.make("environment-b"),
      cwd: "/project-b",
    };
    await render(next);
    await advance(120);
    expect(requests.started.map((request) => request.environmentId)).toEqual([
      target.environmentId,
      next.environmentId,
    ]);
    await completeNext([{ path: "old-environment.txt", kind: "file" }]);
    expect(latest.entries).toEqual([]);
    expect(latest.isPending).toBe(true);
    await completeNext([{ path: "new-environment.txt", kind: "file" }]);
    expect(latest.entries).toEqual([{ path: "new-environment.txt", kind: "file" }]);
    expect(latest.isPending).toBe(false);
  });
});
