import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "../environment/index.js";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";
import { describe, expect, it } from "vite-plus/test";
import {
  archivedThreadActionKey,
  archivedThreadSearchScore,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  tryAcquireArchivedThreadActionLock,
} from "./archivedThreadList.js";
const environmentId = EnvironmentId.make("environment-1");

function scoreArchivedTitle(title: string, query: string): number | null {
  const search = parseArchivedThreadSearchInput(query);
  return archivedThreadSearchScore({
    normalizedTitle: normalizeSearchQuery(title),
    normalizedQuery: search.normalizedQuery,
    tokens: search.tokens,
  });
}

describe("archivedThreadSearchScore", () => {
  it("ranks phrase matches ahead of all-token and partial-token matches", () => {
    const phraseMatch = scoreArchivedTitle("Alpha Beta cleanup", "alpha beta");
    const allTokenMatch = scoreArchivedTitle("Alpha cleanup Beta", "alpha beta");
    const partialTokenMatch = scoreArchivedTitle("Alpha cleanup", "alpha beta");

    expect(phraseMatch).not.toBeNull();
    expect(allTokenMatch).not.toBeNull();
    expect(partialTokenMatch).not.toBeNull();
    expect(phraseMatch!).toBeLessThan(allTokenMatch!);
    expect(allTokenMatch!).toBeLessThan(partialTokenMatch!);
  });

  it("preserves search ranking tiers for matches late in long titles", () => {
    const latePhraseMatch = scoreArchivedTitle(`${"x".repeat(600)} alpha beta`, "alpha beta");
    const earlyAllTokenMatch = scoreArchivedTitle("Alpha cleanup Beta", "alpha beta");
    const lateAllTokenMatch = scoreArchivedTitle(`Alpha ${"x".repeat(3_000)} Beta`, "alpha beta");
    const earlyPartialTokenMatch = scoreArchivedTitle("Alpha cleanup", "alpha beta");

    expect(latePhraseMatch).not.toBeNull();
    expect(earlyAllTokenMatch).not.toBeNull();
    expect(lateAllTokenMatch).not.toBeNull();
    expect(earlyPartialTokenMatch).not.toBeNull();
    expect(latePhraseMatch!).toBeLessThan(earlyAllTokenMatch!);
    expect(lateAllTokenMatch!).toBeLessThan(earlyPartialTokenMatch!);
  });

  it("ranks partial matches by matched-token count before token position", () => {
    const fewerTokens = scoreArchivedTitle("Alpha only", "alpha beta gamma");
    const moreTokens = scoreArchivedTitle(`${"x".repeat(1_200)} Alpha Beta`, "alpha beta gamma");

    expect(fewerTokens).not.toBeNull();
    expect(moreTokens).not.toBeNull();
    expect(moreTokens!).toBeLessThan(fewerTokens!);
  });

  it("ranks distinct matches above repeated occurrences of one query term", () => {
    const query = "alpha alpha alpha beta gamma";
    const oneTerm = scoreArchivedTitle("Alpha", query);
    const twoTerms = scoreArchivedTitle("Beta Gamma", query);

    expect(oneTerm).not.toBeNull();
    expect(twoTerms).not.toBeNull();
    expect(twoTerms!).toBeLessThan(oneTerm!);
  });

  it("matches titles case-insensitively and rejects unrelated titles", () => {
    expect(scoreArchivedTitle("Release Candidate Notes", "candidate")).not.toBeNull();
    expect(scoreArchivedTitle("Release Candidate Notes", "missing")).toBeNull();
  });
});

describe("nextArchivedThreadSortState", () => {
  it("toggles the active sort field and defaults new fields to descending", () => {
    expect(
      nextArchivedThreadSortState({ field: "archivedAt", direction: "desc" }, "archivedAt"),
    ).toEqual({ field: "archivedAt", direction: "asc" });
    expect(
      nextArchivedThreadSortState({ field: "archivedAt", direction: "asc" }, "createdAt"),
    ).toEqual({ field: "createdAt", direction: "desc" });
  });
});

describe("archived thread action locks", () => {
  const firstThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
  const secondThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-2"));

  it("blocks overlapping row and bulk actions until the original lock is released", () => {
    const inFlightThreadKeys = new Set<string>();
    const bulkLock = tryAcquireArchivedThreadActionLock(inFlightThreadKeys, [
      firstThreadRef,
      secondThreadRef,
    ]);

    expect(bulkLock).not.toBeNull();
    expect(tryAcquireArchivedThreadActionLock(inFlightThreadKeys, [firstThreadRef])).toBeNull();

    releaseArchivedThreadActionLock(inFlightThreadKeys, bulkLock!);

    expect(tryAcquireArchivedThreadActionLock(inFlightThreadKeys, [firstThreadRef])).not.toBeNull();
  });

  it("uses collision-safe environment and thread identity", () => {
    const firstKey = archivedThreadActionKey(
      scopeThreadRef(EnvironmentId.make("environment:a"), ThreadId.make("thread")),
    );
    const secondKey = archivedThreadActionKey(
      scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("a:thread")),
    );

    expect(firstKey).not.toBe(secondKey);
  });
});
