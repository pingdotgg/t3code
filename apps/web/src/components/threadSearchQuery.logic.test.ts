import { describe, expect, it } from "vite-plus/test";
import {
  applyProjectSuggestionToQuery,
  filterProjectSuggestions,
  getTrailingProjectOperatorToken,
  hasThreadSearchOperators,
  matchesParsedThreadSearch,
  parseThreadSearchQuery,
  resolveProjectFilterKeys,
  segmentThreadSearchQuery,
} from "./threadSearchQuery.logic";

// Local-time construction on purpose: the day operators resolve against the
// user's calendar, not UTC.
const now = new Date(2026, 7, 9, 12, 30, 0);
const DAY_MS = 86_400_000;

describe("parseThreadSearchQuery", () => {
  it("treats a plain query as lowercased text with no filters", () => {
    const parsed = parseThreadSearchQuery("  Fix Bug ", now);
    expect(parsed).toEqual({
      text: "fix bug",
      projectQueries: [],
      agentQueries: [],
      updatedStartMs: null,
      updatedEndMs: null,
    });
    expect(hasThreadSearchOperators(parsed)).toBe(false);
  });

  it("extracts in: values, including quoted multi-word names", () => {
    const parsed = parseThreadSearchQuery('in:Icarus in:"My Project" fix', now);
    expect(parsed.projectQueries).toEqual(["icarus", "my project"]);
    expect(parsed.text).toBe("fix");
    expect(hasThreadSearchOperators(parsed)).toBe(true);
  });

  it("extracts agent: values", () => {
    const parsed = parseThreadSearchQuery("agent:Claude retry", now);
    expect(parsed.agentQueries).toEqual(["claude"]);
    expect(parsed.text).toBe("retry");
  });

  it("resolves relative before:/after: values against now", () => {
    const parsed = parseThreadSearchQuery("after:7d before:2d", now);
    expect(parsed.updatedStartMs).toBe(now.getTime() - 7 * DAY_MS);
    expect(parsed.updatedEndMs).toBe(now.getTime() - 2 * DAY_MS);
  });

  it("resolves week-relative values", () => {
    const parsed = parseThreadSearchQuery("after:2w", now);
    expect(parsed.updatedStartMs).toBe(now.getTime() - 14 * DAY_MS);
  });

  it("resolves on: to a local calendar day", () => {
    const parsed = parseThreadSearchQuery("on:2026-08-01", now);
    expect(parsed.updatedStartMs).toBe(new Date(2026, 7, 1).getTime());
    expect(parsed.updatedEndMs).toBe(new Date(2026, 7, 2).getTime());
  });

  it("resolves on:today and on:yesterday", () => {
    const today = parseThreadSearchQuery("on:today", now);
    expect(today.updatedStartMs).toBe(new Date(2026, 7, 9).getTime());
    expect(today.updatedEndMs).toBe(new Date(2026, 7, 10).getTime());
    const yesterday = parseThreadSearchQuery("on:yesterday", now);
    expect(yesterday.updatedStartMs).toBe(new Date(2026, 7, 8).getTime());
    expect(yesterday.updatedEndMs).toBe(new Date(2026, 7, 9).getTime());
  });

  it("excludes the named day from before: and after: bounds", () => {
    const parsed = parseThreadSearchQuery("after:2026-08-01 before:2026-08-05", now);
    expect(parsed.updatedStartMs).toBe(new Date(2026, 7, 2).getTime());
    expect(parsed.updatedEndMs).toBe(new Date(2026, 7, 5).getTime());
  });

  it("degrades unparseable and rolled-over dates to plain text", () => {
    expect(parseThreadSearchQuery("before:banana", now).text).toBe("before:banana");
    expect(parseThreadSearchQuery("on:2026-02-31", now).text).toBe("on:2026-02-31");
    expect(parseThreadSearchQuery("on:7d", now).text).toBe("on:7d");
  });

  it("ignores a half-typed operator with no value", () => {
    const parsed = parseThreadSearchQuery("in:", now);
    expect(parsed.text).toBe("");
    expect(hasThreadSearchOperators(parsed)).toBe(false);
  });

  it("leaves unknown operator-shaped tokens as text", () => {
    expect(parseThreadSearchQuery("re: meeting notes", now).text).toBe("re: meeting notes");
  });
});

describe("matchesParsedThreadSearch", () => {
  const makeThread = (input: {
    title?: string;
    updatedAt?: string;
    providerName?: string | null;
    instanceId?: string;
  }) => ({
    title: input.title ?? "Anything",
    updatedAt: input.updatedAt ?? "2026-08-09T10:00:00.000Z",
    modelSelection: { instanceId: input.instanceId ?? "claude-code" },
    session: input.providerName === undefined ? null : { providerName: input.providerName },
  });

  it("matches titles case-insensitively", () => {
    const parsed = parseThreadSearchQuery("work", now);
    expect(matchesParsedThreadSearch(makeThread({ title: "WORKTREE cleanup" }), parsed)).toBe(true);
    expect(matchesParsedThreadSearch(makeThread({ title: "Review providers" }), parsed)).toBe(
      false,
    );
  });

  it("filters by agent against provider name and instance id", () => {
    const parsed = parseThreadSearchQuery("agent:claude", now);
    expect(
      matchesParsedThreadSearch(makeThread({ providerName: "claude", instanceId: "cc" }), parsed),
    ).toBe(true);
    expect(
      matchesParsedThreadSearch(
        makeThread({ providerName: "codex", instanceId: "codex-cli" }),
        parsed,
      ),
    ).toBe(false);
    expect(matchesParsedThreadSearch(makeThread({ instanceId: "claude-code" }), parsed)).toBe(true);
  });

  it("filters by the updatedAt window and rejects malformed timestamps", () => {
    const recent = makeThread({ updatedAt: "2026-08-08T00:00:00.000Z" });
    const old = makeThread({ updatedAt: "2026-07-01T00:00:00.000Z" });
    const after = parseThreadSearchQuery("after:7d", now);
    expect(matchesParsedThreadSearch(recent, after)).toBe(true);
    expect(matchesParsedThreadSearch(old, after)).toBe(false);
    const before = parseThreadSearchQuery("before:7d", now);
    expect(matchesParsedThreadSearch(recent, before)).toBe(false);
    expect(matchesParsedThreadSearch(old, before)).toBe(true);
    expect(matchesParsedThreadSearch(makeThread({ updatedAt: "not-a-date" }), after)).toBe(false);
  });

  it("ANDs operators together", () => {
    const parsed = parseThreadSearchQuery("agent:claude fix", now);
    expect(
      matchesParsedThreadSearch(
        makeThread({ title: "Fix search", providerName: "claude", instanceId: "cc" }),
        parsed,
      ),
    ).toBe(true);
    expect(
      matchesParsedThreadSearch(
        makeThread({ title: "Fix search", providerName: "codex", instanceId: "codex-cli" }),
        parsed,
      ),
    ).toBe(false);
  });
});

describe("resolveProjectFilterKeys", () => {
  const groups = [
    {
      projectKey: "group-icarus",
      displayName: "Icarus",
      workspaceRoot: "/Users/dev/icarus",
      memberProjectRefs: [
        { environmentId: "env-1", projectId: "proj-1" },
        { environmentId: "env-2", projectId: "proj-9" },
      ],
    },
    {
      projectKey: "group-daedalus",
      displayName: "Daedalus",
      workspaceRoot: "/Users/dev/daedalus",
      memberProjectRefs: [{ environmentId: "env-1", projectId: "proj-2" }],
    },
  ];

  it("returns null when there is no in: filter", () => {
    expect(resolveProjectFilterKeys(groups, [])).toBeNull();
  });

  it("expands matching groups into every member project key", () => {
    expect(resolveProjectFilterKeys(groups, ["icarus"])).toEqual(
      new Set(["env-1:proj-1", "env-2:proj-9"]),
    );
  });

  it("matches by workspace path and ORs multiple values", () => {
    expect(resolveProjectFilterKeys(groups, ["dev/daedalus", "icarus"])).toEqual(
      new Set(["env-1:proj-1", "env-2:proj-9", "env-1:proj-2"]),
    );
  });

  it("returns an empty set (zero results, not all) when nothing matches", () => {
    expect(resolveProjectFilterKeys(groups, ["zeus"])).toEqual(new Set());
  });
});

describe("thread search project autocomplete", () => {
  it("detects a trailing partial in: token", () => {
    expect(getTrailingProjectOperatorToken("fix in:ica")).toEqual({
      start: 4,
      partialValue: "ica",
    });
    expect(getTrailingProjectOperatorToken("in:")).toEqual({ start: 0, partialValue: "" });
  });

  it("detects an unterminated quoted value", () => {
    expect(getTrailingProjectOperatorToken('in:"my pro')).toEqual({
      start: 0,
      partialValue: "my pro",
    });
  });

  it("returns null once the operator is committed or absent", () => {
    expect(getTrailingProjectOperatorToken("in:icarus ")).toBeNull();
    expect(getTrailingProjectOperatorToken("fix in:alpha beta")).toBeNull();
    expect(getTrailingProjectOperatorToken("fix")).toBeNull();
  });

  it("replaces the trailing token with a quoted committed filter", () => {
    const token = getTrailingProjectOperatorToken("fix in:ica");
    expect(applyProjectSuggestionToQuery("fix in:ica", token, "Icarus")).toBe('fix in:"Icarus" ');
  });

  it("replaces the whole query when no trailing token exists", () => {
    expect(applyProjectSuggestionToQuery("icarus", null, "Icarus")).toBe('in:"Icarus" ');
  });

  it("ranks suggestions: name prefix, then name substring, then path", () => {
    const groups = [
      { displayName: "Tools", workspaceRoot: "/dev/icarus-tools" },
      { displayName: "My Icarus Fork", workspaceRoot: "/dev/fork" },
      { displayName: "Icarus", workspaceRoot: "/dev/icarus" },
      { displayName: "Unrelated", workspaceRoot: "/dev/other" },
    ];
    expect(filterProjectSuggestions(groups, "ica").map((group) => group.displayName)).toEqual([
      "Icarus",
      "My Icarus Fork",
      "Tools",
    ]);
  });

  it("skips workspace-path matches when matchWorkspaceRoot is false", () => {
    const groups = [
      { displayName: "Icarus", workspaceRoot: "/dev/icarus" },
      { displayName: "Tools", workspaceRoot: "/dev/icarus-tools" },
    ];
    expect(
      filterProjectSuggestions(groups, "ica", { matchWorkspaceRoot: false }).map(
        (group) => group.displayName,
      ),
    ).toEqual(["Icarus"]);
  });

  it("lists every project for an empty partial value", () => {
    const groups = [
      { displayName: "Alpha", workspaceRoot: "/a" },
      { displayName: "Beta", workspaceRoot: "/b" },
    ];
    expect(filterProjectSuggestions(groups, "")).toEqual(groups);
  });
});

describe("segmentThreadSearchQuery", () => {
  it("returns the whole query as one plain segment when there are no operators", () => {
    expect(segmentThreadSearchQuery("fix wing telemetry", now)).toEqual([
      { text: "fix wing telemetry", isOperator: false },
    ]);
  });

  it("highlights operator tokens and reproduces the input verbatim", () => {
    const query = 'fix in:"My Project" after:7d tail';
    const segments = segmentThreadSearchQuery(query, now);
    expect(segments).toEqual([
      { text: "fix ", isOperator: false },
      { text: 'in:"My Project"', isOperator: true },
      { text: " ", isOperator: false },
      { text: "after:7d", isOperator: true },
      { text: " tail", isOperator: false },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(query);
  });

  it("highlights a bare operator keyword while its value is being typed", () => {
    expect(segmentThreadSearchQuery("in:", now)).toEqual([{ text: "in:", isOperator: true }]);
  });

  it("does not highlight tokens the parser degrades to plain text", () => {
    expect(segmentThreadSearchQuery("before:banana", now)).toEqual([
      { text: "before:banana", isOperator: false },
    ]);
    expect(segmentThreadSearchQuery("on:7d", now)).toEqual([{ text: "on:7d", isOperator: false }]);
    expect(segmentThreadSearchQuery("re: meeting", now)).toEqual([
      { text: "re: meeting", isOperator: false },
    ]);
  });
});
