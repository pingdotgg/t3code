import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the settled query and matches stable while typing, then reports the settled query", () => {
    const results: ThreadSearch[] = [];
    const render = (query: string) => {
      const element = <Probe query={query} onResult={(result) => results.push(result)} />;
      act(() => root.render(element));
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
