import { describe, expect, it } from "@effect/vitest";

import { hostLabelQuery, labelAppliedOnHost, labelCandidateView } from "./pullRequestLabels.ts";

const label = (name: string) => ({ name, color: null, description: null, isApplied: false });
const firstPage = { candidates: [label("area: one"), label("area: two")], truncated: true };
const idle = { data: null, isPending: false };

describe("labelCandidateView", () => {
  it("asks the host only when the loaded page is not every label", () => {
    expect(hostLabelQuery({ loaded: firstPage, debouncedQuery: " ready " })).toBe("ready");
    expect(hostLabelQuery({ loaded: firstPage, debouncedQuery: "" })).toBeNull();
    expect(
      hostLabelQuery({ loaded: { ...firstPage, truncated: false }, debouncedQuery: "ready" }),
    ).toBeNull();
  });

  it("lists the host's matches once the debounce caught up, and waits for them before that", () => {
    const search = {
      data: { candidates: [label("ready to merge")], truncated: false },
      isPending: false,
    };
    expect(
      labelCandidateView({ loaded: firstPage, query: "ready", debouncedQuery: "ready", search }),
    ).toEqual({ candidates: [label("ready to merge")], searchPending: false, truncated: false });
    expect(
      labelCandidateView({ loaded: firstPage, query: "ready", debouncedQuery: "rea", search }),
    ).toEqual({ candidates: [], searchPending: true, truncated: true });
  });

  it("falls back to the loaded page when the host search failed", () => {
    expect(
      labelCandidateView({ loaded: firstPage, query: "two", debouncedQuery: "two", search: idle }),
    ).toEqual({ candidates: [label("area: two")], searchPending: false, truncated: true });
    expect(
      labelCandidateView({ loaded: firstPage, query: "zzz", debouncedQuery: "zzz", search: idle })
        .searchPending,
    ).toBe(false);
  });

  it("reads the host's applied state, or the picked one where the lists disagree", () => {
    const picked = { ...label("ready"), isApplied: true };
    const searched = { candidates: [picked], truncated: false };
    const stale = { candidates: [label("ready")], truncated: true };
    expect(labelAppliedOnHost([stale, searched], picked)).toBe(true);
    expect(labelAppliedOnHost([stale, null], picked)).toBe(false);
    expect(labelAppliedOnHost([firstPage, null], picked)).toBe(true);
  });
});
