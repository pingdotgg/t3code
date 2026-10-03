import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadSearch } from "./queries";

const searchResults = vi.hoisted(() => ({
  matches: [{ threadId: "thread-1", source: "user", snippet: "a link" }],
  isLoading: false,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: { label?: ReadonlyArray<unknown> }) =>
    String(atom.label?.[0]).includes("empty") ? { matches: [], isLoading: false } : searchResults,
}));

const environmentIds = [EnvironmentId.make("local")];
type ThreadSearch = ReturnType<typeof useThreadSearch>;

function Probe(props: { query: string; onResult: (result: ThreadSearch) => void }) {
  props.onResult(useThreadSearch(environmentIds, props.query));
  return null;
}

describe("useThreadSearch", () => {
  let renderer: ReactTestRenderer | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the settled query and matches stable while typing, then reports the settled query", () => {
    const results: ThreadSearch[] = [];
    const render = (query: string) => {
      const element = <Probe query={query} onResult={(result) => results.push(result)} />;
      act(() => {
        if (renderer) renderer.update(element);
        else renderer = create(element);
      });
      return results.at(-1)!;
    };

    render("");
    const typing = ["li", "lin", "link "].map(render);
    expect(typing.map((result) => result.query)).toEqual(["", "", ""]);
    expect(new Set(typing.map((result) => result.matches)).size).toBe(1);
    expect(typing.every((result) => result.isPending)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    const settled = results.at(-1)!;
    expect(settled.query).toBe("link");
    expect(settled.matches).toBe(searchResults.matches);
    expect(settled.isPending).toBe(false);
  });
});
