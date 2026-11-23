import { describe, expect, it } from "@effect/vitest";

import { hostLabelQuery, labelCandidateView, mergeLabelCandidates } from "./pullRequestLabels.ts";

const label = (
  name: string,
  { isApplied = false, description = null } = {} as {
    isApplied?: boolean;
    description?: string | null;
  },
) => ({ name, color: null, description, isApplied });

const labelList = (candidates: ReturnType<typeof label>[], truncated = false) => ({
  candidates,
  truncated,
});

const search = (
  data: ReturnType<typeof labelList> | null,
  { isPending = false, error = null } = {} as {
    isPending?: boolean;
    error?: string | null;
  },
) => ({ data, isPending, error });

describe("mergeLabelCandidates", () => {
  it("narrows the loaded candidates by name or description", () => {
    const loaded = [
      label("area: web"),
      label("ready to merge", { description: "Ship it" }),
      label("bug"),
    ];
    expect(mergeLabelCandidates(loaded, [], "READY").map((entry) => entry.name)).toEqual([
      "ready to merge",
    ]);
    expect(mergeLabelCandidates(loaded, [], "ship").map((entry) => entry.name)).toEqual([
      "ready to merge",
    ]);
  });

  it("adds candidates only the host's search found, after the loaded ones", () => {
    const loaded = [label("area: web"), label("area: api")];
    const searched = [label("area: api"), label("area: infra")];
    expect(mergeLabelCandidates(loaded, searched, "area").map((entry) => entry.name)).toEqual([
      "area: web",
      "area: api",
      "area: infra",
    ]);
  });

  it("keeps the loaded entry for a label both lists name, since a write updates that one", () => {
    const loaded = [label("ready to merge", { isApplied: true })];
    expect(mergeLabelCandidates(loaded, [label("ready to merge")], "ready")).toEqual(loaded);
  });
});

describe("hostLabelQuery", () => {
  it("asks the host only once the loaded page is known to be short", () => {
    const base = { searchable: true, query: "ready", debouncedQuery: "ready" };
    expect(hostLabelQuery({ ...base, loaded: labelList([label("bug")]) })).toBeNull();
    expect(hostLabelQuery({ ...base, loaded: labelList([label("bug")], true) })).toBe("ready");
  });

  it("stays quiet on a host that cannot search, and before anything is typed", () => {
    const truncated = labelList([label("bug")], true);
    expect(
      hostLabelQuery({ loaded: truncated, searchable: false, query: "r", debouncedQuery: "r" }),
    ).toBeNull();
    expect(
      hostLabelQuery({ loaded: truncated, searchable: true, query: "", debouncedQuery: "" }),
    ).toBeNull();
    expect(
      hostLabelQuery({ loaded: null, searchable: true, query: "r", debouncedQuery: "r" }),
    ).toBeNull();
  });
});

describe("labelCandidateView", () => {
  const truncated = labelList([label("area: web"), label("area: api")], true);

  it("reports the label past the first page that the host search found", () => {
    const view = labelCandidateView({
      loaded: truncated,
      searchable: true,
      query: "ready to merge",
      debouncedQuery: "ready to merge",
      search: search(labelList([label("ready to merge")])),
    });
    expect(view.candidates.map((entry) => entry.name)).toEqual(["ready to merge"]);
    expect(view.truncation).toBeNull();
  });

  it("says the host is still being asked rather than that nothing matches", () => {
    const view = labelCandidateView({
      loaded: truncated,
      searchable: true,
      query: "ready",
      debouncedQuery: "ready",
      search: search(null, { isPending: true }),
    });
    expect(view.candidates).toEqual([]);
    expect(view.searchPending).toBe(true);
  });

  it("explains a short list by whether the host can be asked at all", () => {
    const unsearchable = labelCandidateView({
      loaded: truncated,
      searchable: false,
      query: "ready",
      debouncedQuery: "ready",
      search: search(null),
    });
    expect(unsearchable.truncation).toBe("unsearchable");
    expect(unsearchable.searchPending).toBe(false);

    const awake = labelCandidateView({
      loaded: truncated,
      searchable: true,
      query: "",
      debouncedQuery: "",
      search: search(null),
    });
    expect(awake.truncation).toBe("searchable");
  });

  it("carries the host's failure and its own truncation through", () => {
    const failed = labelCandidateView({
      loaded: truncated,
      searchable: true,
      query: "ready",
      debouncedQuery: "ready",
      search: search(null, { error: "boom" }),
    });
    expect(failed.truncation).toBe("search-failed");
    expect(failed.searchError).toBe("boom");

    const cut = labelCandidateView({
      loaded: truncated,
      searchable: true,
      query: "area",
      debouncedQuery: "area",
      search: search(labelList([label("area: web")], true)),
    });
    expect(cut.truncation).toBe("search-truncated");
  });
});
