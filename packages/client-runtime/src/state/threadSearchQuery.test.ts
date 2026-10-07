// @effect-diagnostics globalDate:off -- Tests inject local-calendar boundaries.

import { describe, expect, it } from "vite-plus/test";

import {
  clearThreadSearchQualifiers,
  matchesThreadSearchFilters,
  parseThreadSearchQuery,
  toggleThreadSearchQualifier,
} from "./threadSearchQuery.ts";

const now = new Date("2026-10-07T15:30:00");
const thread = { updatedAt: "2026-10-07T10:00:00", branch: "feature/search" };
const context = {
  projectName: () => "My App",
  environmentNames: () => ["Office Mac", "Local"],
  providerNames: () => ["claudeAgent", "Claude"],
  status: () => "failed",
  activityAt: (value: typeof thread) => value.updatedAt,
};

describe("thread search query", () => {
  it("parses quoted values, aliases, comma OR, and negation", () => {
    const parsed = parseThreadSearchQuery(
      'project:"my app" provider:codex,claude -status:waiting hello',
      { now },
    );
    expect(parsed.text).toBe("hello");
    expect(parsed.filters.project[0]?.values).toEqual(["my app"]);
    expect(parsed.filters.provider[0]?.values).toEqual(["codex", "claude"]);
    expect(parsed.filters.status[0]?.negated).toBe(true);
    expect(parsed.hasFilters).toBe(true);
  });

  it("keeps unknown and invalid qualifiers as text", () => {
    expect(parseThreadSearchQuery("foo:bar since:banana", { now })).toEqual({
      text: "foo:bar since:banana",
      filters: {
        project: [],
        env: [],
        branch: [],
        provider: [],
        status: [],
        since: [],
        before: [],
        archived: false,
      },
      hasFilters: false,
    });
  });

  it("keeps apostrophes and backslashes literal", () => {
    expect(parseThreadSearchQuery("don't fix C:\\repo", { now }).text).toBe("don't fix C:\\repo");
  });

  it("does not let an unbalanced double quote swallow later tokens", () => {
    const parsed = parseThreadSearchQuery('project:"my app status:failed', { now });
    expect(parsed.text).toBe('project:"my app');
    expect(parsed.filters.status[0]?.values).toEqual(["failed"]);
  });

  it("matches all qualifier families and local day boundaries", () => {
    const parsed = parseThreadSearchQuery(
      "in:app env:office branch:feature provider:claude status:error since:today before:2026-10-08",
      { now },
    );
    expect(matchesThreadSearchFilters(thread, parsed.filters, context, { now })).toBe(true);
    expect(
      matchesThreadSearchFilters(
        thread,
        parseThreadSearchQuery("-branch:feature", { now }).filters,
        context,
        { now },
      ),
    ).toBe(false);
    expect(parseThreadSearchQuery("is:archived", { now }).filters.archived).toBe(true);
  });

  it("matches dates against the resolved activity timestamp and all environment names", () => {
    const activityThread = {
      updatedAt: "2026-10-07T10:00:00",
      latestUserMessageAt: "2026-09-20T10:00:00",
      branch: null,
    };
    const activityContext = {
      ...context,
      activityAt: (value: typeof activityThread) => value.latestUserMessageAt,
    };
    expect(
      matchesThreadSearchFilters(
        activityThread,
        parseThreadSearchQuery("since:7d env:local", { now }).filters,
        activityContext,
        { now },
      ),
    ).toBe(false);
    expect(
      matchesThreadSearchFilters(
        { ...activityThread, latestUserMessageAt: "2026-10-06T10:00:00" },
        parseThreadSearchQuery("since:7d env:local", { now }).filters,
        activityContext,
        { now },
      ),
    ).toBe(true);
  });

  it("edits multi-value qualifiers and quotes project names", () => {
    expect(
      toggleThreadSearchQualifier("hello status:failed", "status", "input", { multi: true }),
    ).toBe("hello status:failed,input");
    expect(
      toggleThreadSearchQualifier("status:failed,input", "status", "failed", { multi: true }),
    ).toBe("status:input");
    expect(toggleThreadSearchQualifier("hello", "project", "My App", { multi: true })).toBe(
      'hello project:"My App"',
    );
  });

  it("replaces single-value qualifiers and toggles archived", () => {
    expect(toggleThreadSearchQualifier("since:7d hello", "since", "today", { multi: false })).toBe(
      "since:today hello",
    );
    expect(
      toggleThreadSearchQualifier("is:archived hello", "archived", "archived", { multi: false }),
    ).toBe("hello");
  });

  it("leaves negated qualifiers alone and clears recognized qualifiers", () => {
    expect(
      toggleThreadSearchQualifier("-status:failed status:ready", "status", "failed", {
        multi: true,
      }),
    ).toBe("-status:failed status:ready,failed");
    expect(clearThreadSearchQualifiers('hello -status:failed project:"My App" unknown:value')).toBe(
      "hello unknown:value",
    );
  });

  it("merges repeated positive clauses at the first qualifier's position", () => {
    const query = 'first in:"My App" middle project:Docs last';
    const next = toggleThreadSearchQualifier(query, "project", "Website", { multi: true });
    expect(next).toBe('first project:"My App",Docs,Website middle last');
    expect(parseThreadSearchQuery(next, { now }).filters.project).toEqual([
      { values: ["My App", "Docs", "Website"], negated: false },
    ]);
  });

  it("removes the final value without moving or rewriting free text", () => {
    const query = '"fix this" status:FAILED don\'t C:\\repo unknown:"my thing"';
    expect(toggleThreadSearchQualifier(query, "status", "failed", { multi: true })).toBe(
      '"fix this" don\'t C:\\repo unknown:"my thing"',
    );
  });

  it("adds and removes single-value filters while retaining negated filters", () => {
    expect(toggleThreadSearchQualifier("-since:7d fix", "since", "today", { multi: false })).toBe(
      "-since:7d fix since:today",
    );
    expect(toggleThreadSearchQualifier("since:today fix", "since", "today", { multi: false })).toBe(
      "fix",
    );
    expect(
      toggleThreadSearchQualifier("-is:archived fix", "archived", "archived", { multi: false }),
    ).toBe("-is:archived fix is:archived");
    expect(
      toggleThreadSearchQualifier("since:7d text since:30d", "since", "today", { multi: false }),
    ).toBe("since:today text");
  });

  it("clears all qualifier families and preserves invalid and unknown tokens verbatim", () => {
    const query =
      '"fix this" in:"My App" environment:Local branch:main provider:Claude -status:error since:7d before:2026-10-08 is:archived -is:archived foo:"my thing" since:banana since:2026-02-30 status:unknown ""';
    expect(clearThreadSearchQualifiers(query)).toBe(
      '"fix this" foo:"my thing" since:banana since:2026-02-30 status:unknown ""',
    );
  });

  it("normalizes status aliases when merging and removing values", () => {
    expect(
      toggleThreadSearchQualifier("status:error,awaiting", "status", "working", { multi: true }),
    ).toBe("status:failed,input,working");
    expect(
      toggleThreadSearchQualifier("status:error,awaiting", "status", "failed", { multi: true }),
    ).toBe("status:input");
  });
});
