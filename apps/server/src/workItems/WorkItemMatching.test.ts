import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkItemMatches,
  shortlistWorkItemCandidates,
  workItemIdentityKey,
} from "./WorkItemMatching.ts";

const source = {
  kind: "issue" as const,
  provider: "github",
  repository: "acme/app",
  number: 12,
  title: "Active sessions expire early",
  url: "https://github.com/acme/app/issues/12",
  body: "Refresh active sessions before expiry.",
};

const candidate = (number: number, title = `Unrelated change ${number}`) => ({
  kind: "pull-request" as const,
  provider: "github",
  projectId: "project-1",
  repository: "acme/app",
  number,
  title,
  url: `https://github.com/acme/app/pull/${number}`,
});

describe("shortlistWorkItemCandidates", () => {
  it("excludes the source, ranks title overlap, and bounds detail reads", () => {
    const candidates = [
      { ...candidate(12), kind: "issue" as const },
      ...Array.from({ length: 12 }, (_, index) => candidate(index + 20)),
      candidate(99, "Refresh active sessions before expiry"),
    ];

    const shortlisted = shortlistWorkItemCandidates(source, candidates);

    expect(shortlisted).toHaveLength(12);
    expect(shortlisted[0]?.number).toBe(99);
    expect(shortlisted.some((entry) => entry.number === 12 && entry.kind === "issue")).toBe(false);
  });

  it("keeps equal references from different providers", () => {
    const otherProvider = { ...source, provider: "linear" };

    expect(shortlistWorkItemCandidates(source, [otherProvider])).toEqual([otherProvider]);
    expect(workItemIdentityKey(source)).not.toBe(workItemIdentityKey(otherProvider));
  });
});

describe("resolveWorkItemMatches", () => {
  it("maps trusted candidates once and drops invalid model indexes", () => {
    const candidates = [candidate(34), candidate(35)];
    const matches = resolveWorkItemMatches(candidates, [
      { candidate: 2, confidence: "high" as const, reason: " Same change. " },
      { candidate: 2, confidence: "medium" as const, reason: "Repeated." },
      { candidate: 99, confidence: "high" as const, reason: "Invented." },
      { candidate: 1, confidence: "medium" as const, reason: "   " },
    ]);

    expect(matches).toEqual([
      {
        kind: "pull-request",
        provider: "github",
        repository: "acme/app",
        number: 35,
        title: "Unrelated change 35",
        url: "https://github.com/acme/app/pull/35",
        confidence: "high",
        reason: "Same change.",
      },
    ]);
  });
});
