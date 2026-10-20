import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
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
  it("keeps the settled query and matches stable while typing, then reports the settled query", async () => {
    using _timers = fakeTimers();
    const results: ThreadSearch[] = [];
    const probe = (query: string) => (
      <Probe query={query} onResult={(result) => results.push(result)} />
    );
    await using screen = await render(probe(""));
    const typing: ThreadSearch[] = [];
    for (const query of ["li", "lin", "link "]) {
      await screen.rerender(probe(query));
      typing.push(results.at(-1)!);
    }
    expect(typing.map((result) => result.query)).toEqual(["", "", ""]);
    expect(new Set(typing.map((result) => result.matches)).size).toBe(1);
    expect(typing.every((result) => result.isPending)).toBe(true);

    await act(() => {
      vi.advanceTimersByTime(200);
    });
    const settled = results.at(-1)!;
    expect(settled.query).toBe("link");
    expect(settled.matches).toBe(searchResults.matches);
    expect(settled.isPending).toBe(false);
  });
});
