import { describe, expect, it } from "vite-plus/test";

import {
  findSearchTokenRanges,
  foldSearchQuery,
  pickedQuery,
  rankMessageMatches,
  rankSearchGroups,
  rankSearchItems,
  recordThreadOpen,
  messageMatcher,
  scoreSearchTerms,
  scoreThreadSearch,
  SEARCH_RECENCY_HALF_LIFE_MS,
  type SearchTermsMatch,
  type ThreadSearchSubject,
} from "./paletteSearch.ts";

const NOW = Date.UTC(2026, 9, 23);
const scoreMessageMatch = (text: string, query: string) => messageMatcher(query)(text);
const DAY = 24 * 60 * 60 * 1000;

function thread(title: string, overrides: Partial<ThreadSearchSubject> = {}): ThreadSearchSubject {
  return { title, activityAt: NOW - 30 * DAY, ...overrides };
}

function rankTitles(query: string, threads: ReadonlyArray<ThreadSearchSubject>): string[] {
  const normalized = foldSearchQuery(query);
  return rankSearchItems(threads, (subject, options) =>
    scoreThreadSearch(normalized, subject, NOW, options),
  ).map(({ item }) => item.title);
}

describe("scoreThreadSearch", () => {
  it("ranks whole words over prefixes over newer mid-word matches", () => {
    expect(
      rankTitles("auth", [
        thread("Fix oauth redirect", { activityAt: NOW }),
        thread("Authentication cleanup"),
        thread("Share auth across worktrees"),
      ]),
    ).toEqual(["Share auth across worktrees", "Authentication cleanup", "Fix oauth redirect"]);
  });

  it("treats camelCase, kebab, path, and digit boundaries as word starts", () => {
    const starts = (title: string, query: string) =>
      scoreThreadSearch(query, thread(title), NOW)?.ranges;
    expect(starts("useThreadSearch hook", "search")).toEqual([{ start: 9, end: 15 }]);
    expect(starts("fix/sidebar-perf", "perf")).toEqual([{ start: 12, end: 16 }]);
    expect(starts("Upgrade to pnpm12", "12")).toEqual([{ start: 15, end: 17 }]);
    expect(starts("Fix JSONSchema parsing", "sch")).toEqual([{ start: 8, end: 11 }]);
    expect(starts("Fix HTTPServer crash", "ser")).toEqual([{ start: 8, end: 11 }]);
    expect(starts("Rename index.ts", ".ts")).toEqual([{ start: 12, end: 15 }]);
    // A match is whole only where a word ends: "githuba" does not fill "GitHubActions".
    expect(scoreThreadSearch("githuba", thread("GitHubActions setup"), NOW)?.quality).toBeLessThan(
      1,
    );
    expect(rankTitles(".ts", [thread("Fix parser.tsx"), thread("Rename index.ts")])).toEqual([
      "Rename index.ts",
      "Fix parser.tsx",
    ]);
    // Short tokens never match mid-word.
    expect(scoreThreadSearch("ci", thread("Decision log"), NOW)).toBeNull();
  });

  it("lets recent activity and frequent opens decide between equal matches", () => {
    expect(
      rankTitles("goldbug", [
        thread("Goldbug epilogue", { activityAt: NOW - 20 * DAY }),
        thread("Goldbug processes", { activityAt: NOW - DAY }),
      ]),
    ).toEqual(["Goldbug processes", "Goldbug epilogue"]);
    expect(
      rankTitles("goldbug", [
        thread("Goldbug processes", { activityAt: NOW - DAY }),
        thread("Goldbug notes", {
          activityAt: NOW - 40 * DAY,
          opens: { openedAt: NOW - DAY, score: 12, picks: [] },
        }),
      ]),
    ).toEqual(["Goldbug notes", "Goldbug processes"]);
  });

  it("puts the thread picked for a query first when that query is typed again", () => {
    const threads = [
      thread("Release checklist", {
        opens: { openedAt: NOW - 5 * DAY, score: 1, picks: [{ query: "rel", at: NOW - 5 * DAY }] },
      }),
      thread("Relay pairing", { activityAt: NOW }),
    ];
    expect(rankTitles("rel", threads)).toEqual(["Release checklist", "Relay pairing"]);
    // A pick never lifts a match inside a word above a word match.
    expect(
      rankTitles("auth", [
        thread("Fix oauth redirect", {
          opens: { openedAt: NOW - DAY, score: 1, picks: [{ query: "auth", at: NOW - DAY }] },
        }),
        thread("Share auth across worktrees"),
      ]),
    ).toEqual(["Share auth across worktrees", "Fix oauth redirect"]);
    // Two letters are too little to go on.
    expect(rankTitles("re", threads)).toEqual(["Relay pairing", "Release checklist"]);
    // Once the query leaves the pick behind, the better match wins again.
    expect(rankTitles("rela", threads)).toEqual(["Relay pairing"]);
    // An old pick fades with the thread's last open.
    const stale = [
      thread("Release checklist", {
        opens: {
          openedAt: NOW - 90 * DAY,
          score: 1,
          picks: [{ query: "rel", at: NOW - 90 * DAY }],
        },
      }),
      thread("Relay pairing", { activityAt: NOW }),
    ];
    expect(rankTitles("rel", stale)).toEqual(["Relay pairing", "Release checklist"]);
    // Opening an old pick some other way does not revive it over a newer pick.
    const reopened = [
      thread("Release checklist", {
        opens: { openedAt: NOW - DAY, score: 2, picks: [{ query: "rel", at: NOW - 30 * DAY }] },
      }),
      thread("Relay pairing", {
        opens: { openedAt: NOW - DAY, score: 1, picks: [{ query: "rel", at: NOW - DAY }] },
      }),
    ];
    expect(rankTitles("rel", reopened)).toEqual(["Relay pairing", "Release checklist"]);
    // The latest pick for a query wins over an earlier one with a better title match.
    const repicked = [
      thread("Deploy", {
        opens: { openedAt: NOW - DAY, score: 1, picks: [{ query: "deploy", at: NOW - DAY }] },
      }),
      thread("Deploy timeout on Railway", {
        opens: { openedAt: NOW, score: 1, picks: [{ query: "deploy", at: NOW }] },
      }),
    ];
    expect(rankTitles("deploy", repicked)).toEqual(["Deploy timeout on Railway", "Deploy"]);
    // A thread's exact pick counts even after a newer pick for a longer query.
    const exact = [
      thread("Fix browser", {
        opens: {
          openedAt: NOW,
          score: 2,
          picks: [
            { query: "fix browser", at: NOW },
            { query: "fix", at: NOW - 2 * DAY },
          ],
        },
      }),
      thread("Fix sidebar", {
        opens: { openedAt: NOW - DAY, score: 1, picks: [{ query: "fix", at: NOW - DAY }] },
      }),
    ];
    expect(rankTitles("fix", exact)).toEqual(["Fix sidebar", "Fix browser"]);
    // A pick for a longer query does not pass the thread named by the query.
    const named = [
      thread("Lakebed perf audit", {
        opens: { openedAt: NOW, score: 1, picks: [{ query: "lakebed perf", at: NOW }] },
      }),
      thread("Lakebed"),
    ];
    expect(rankTitles("lakebed", named)).toEqual(["Lakebed", "Lakebed perf audit"]);
  });

  it("finds a branch pasted with the app's worktree prefix", () => {
    const subject = thread("Cmd+K search", { branch: "t3/cmdk-search-v2" });
    expect(scoreThreadSearch(foldSearchQuery("t3/cmdk-search-v2"), subject, NOW)).not.toBeNull();
    expect(scoreThreadSearch(foldSearchQuery("t3/cmdk"), subject, NOW)).not.toBeNull();
  });

  it("ranks a title holding the words above the app's own branch prefix and project name", () => {
    const busy = { activityAt: NOW, opens: { openedAt: NOW, score: 6, picks: [] } };
    expect(
      rankTitles("t3 connect", [
        thread("Diagnose Connect provisioning failures", {
          ...busy,
          branch: "t3/diagnose-connect",
          projectTitle: "t3code",
        }),
        thread("T3 Connect Tunnel Lifecycle Review", { projectTitle: "t3code" }),
      ])[0],
    ).toBe("T3 Connect Tunnel Lifecycle Review");
    expect(
      rankTitles("t3code", [
        thread("Fix sidebar lag", { ...busy, projectTitle: "t3code", branch: "t3code/sidebar" }),
        thread("T3 Code vs Gemini Token Volume", { projectTitle: "slophouse" }),
      ])[0],
    ).toBe("T3 Code vs Gemini Token Volume");
  });

  it("matches pull request numbers, branches, and projects with every token somewhere", () => {
    const subject = thread("Trim model lists", {
      branch: "t3/trim-mcp-models",
      projectTitle: "t3code",
      pullRequests: [{ number: 22889, title: "Smaller MCP payloads" }],
    });
    for (const query of ["#22889", "22889", "trim mcp", "payloads t3code", "models trim"]) {
      expect(scoreThreadSearch(foldSearchQuery(query), subject, NOW), query).not.toBeNull();
    }
    expect(scoreThreadSearch("trim lakebed", subject, NOW)).toBeNull();
  });

  it("forgives one typo only when nothing matches exactly", () => {
    const threads = [thread("Hosting alternatives to Railway"), thread("Trim MCP model lists")];
    expect(rankTitles("railwya", threads)).toEqual(["Hosting alternatives to Railway"]);
    expect(rankTitles("trim mpc", threads)).toEqual(["Trim MCP model lists"]);
    expect(
      rankTitles("drga", [thread("Restore drag handles"), thread("Organize indicators")]),
    ).toEqual(["Restore drag handles"]);
    expect(rankTitles("22889", [thread("Stats", { pullRequests: [{ number: 22189 }] })])).toEqual(
      [],
    );
    // Words with digits still forgive one.
    expect(rankTitles("t3coed", [thread("t3code perf audit"), thread("Other")])).toEqual([
      "t3code perf audit",
    ]);
    expect(rankTitles("oath2", [thread("Fix oauth2 redirect")])).toEqual(["Fix oauth2 redirect"]);
    // A typo beats a mid-word accident: "ilde" is "idle", not the middle of "Builder".
    expect(
      rankTitles("ilde", [thread("Typesafe App Builder"), thread("De-risk idle tunnel cleanup")]),
    ).toEqual(["De-risk idle tunnel cleanup", "Typesafe App Builder"]);
    // "ing" is not "Nightly": a three-letter typo keeps the first letter.
    expect(rankTitles("ing", [thread("Nightly build fix")])).toEqual([]);
    // A short word may miss one letter while it is typed, but not change one.
    expect(rankTitles("srv", [thread("Server restart"), thread("Other")])).toEqual([
      "Server restart",
    ]);
    expect(rankTitles("sidb", [thread("Fix sidebar lag")])).toEqual(["Fix sidebar lag"]);
    expect(rankTitles("cron", [thread("Config cleanup")])).toEqual([]);
    // Filler words in a phrase-style query are not required, but alone they are.
    expect(rankTitles("fix the sidebar", [thread("Fix Sidebar Lag")])).toEqual(["Fix Sidebar Lag"]);
    expect(rankTitles("the", [thread("Fix sidebar lag")])).toEqual([]);
    // A typed straight apostrophe finds a curly one.
    expect(rankTitles("don't", [thread("Don’t merge yet")])).toEqual(["Don’t merge yet"]);
    // Typos count across camelCase joins.
    expect(rankTitles("githbu", [thread("GitHub API usage"), thread("Other")])).toEqual([
      "GitHub API usage",
    ]);
    expect(rankTitles("macso", [thread("Fix macOS window"), thread("Other")])).toEqual([
      "Fix macOS window",
    ]);
    // "enter" is not "external" when the right thread is already there.
    expect(
      rankTitles("cmd enter", [thread("Fix Cmd+Enter"), thread("Open links external")]),
    ).toEqual(["Fix Cmd+Enter"]);
  });
});

describe("queries that fold to empty words", () => {
  it("returns for a hash and a space, or marks that fold to nothing", () => {
    expect(rankTitles("# fix", [thread("Fix sidebar lag")])).toEqual(["Fix sidebar lag"]);
    expect(rankTitles("#", [thread("Fix sidebar lag")])).toEqual([]);
    expect(rankTitles("´´´", [thread("Fix sidebar lag")])).toEqual([]);
    expect(scoreSearchTerms("# fix", ["Fix sidebar"])).toBeNull();
    expect(findSearchTokenRanges("Fix sidebar", "´´´")).toEqual([]);
    expect(scoreMessageMatch("Fix sidebar", "´´´")).toBeNull();
  });
});

describe("scoreThreadSearch beyond Latin text and titles", () => {
  it("leaves out a row whose words only meet across unrelated fields", () => {
    const scattered = thread("eMudhra certificate update request", {
      pullRequests: [
        { number: 22645, title: "fix model picker" },
        { number: 22649, title: "CI speedups" },
      ],
    });
    expect(scoreThreadSearch("fix ci", scattered, NOW)).toBeNull();
    // The project explains its own words; one field explains the rest.
    const lakebed = thread("Weekly notes", {
      projectTitle: "lakebed",
      pullRequests: [{ number: 243, title: "perf: faster cold starts" }],
    });
    expect(scoreThreadSearch("lakebed perf", lakebed, NOW)?.explain?.()).toEqual({
      label: "PR",
      text: "#243 perf: faster cold starts",
      ranges: [{ start: 5, end: 9 }],
    });
  });

  it("says which field matched when the title does not", () => {
    const subject = thread("Trim model lists", {
      branch: "t3/cleanup-payloads",
      pullRequests: [{ number: 22889, title: "Smaller MCP payloads" }],
    });
    for (const query of ["#22889", "pr 22889", "pr22889", "pull request #22889"]) {
      expect(scoreThreadSearch(foldSearchQuery(query), subject, NOW)?.explain?.(), query).toEqual({
        label: "PR",
        text: "#22889 Smaller MCP payloads",
        ranges: [{ start: 1, end: 6 }],
      });
    }
    // The app's own worktree prefix is not part of what the branch says.
    expect(scoreThreadSearch("cleanup", subject, NOW)?.explain?.()).toEqual({
      label: "Branch",
      text: "cleanup-payloads",
      ranges: [{ start: 0, end: 7 }],
    });
    expect(scoreThreadSearch("trim", subject, NOW)?.explain?.()).toBeUndefined();
  });

  it("reads letters and numbers typed together, without forgiving typos in numbers", () => {
    const threads = [
      thread("Upgrade to pnpm 12"),
      thread("GPT-5 eval"),
      thread("iOS 26 support"),
      thread("Other"),
    ];
    expect(rankTitles("pnpm12", threads)).toEqual(["Upgrade to pnpm 12"]);
    expect(rankTitles("gpt5", threads)).toEqual(["GPT-5 eval"]);
    expect(rankTitles("ios26", threads)).toEqual(["iOS 26 support"]);
    expect(rankTitles("pnpm13", threads)).toEqual([]);
  });

  it("reads whole words typed together, but not scattered letters", () => {
    const threads = [
      thread("VS Code extension settings"),
      thread("Fix UI bug in sidebar"),
      thread("I plan to open source all of lakebed in the next few weeks"),
    ];
    expect(rankTitles("vscode", threads)).toEqual(["VS Code extension settings"]);
    expect(rankTitles("fixuibug", threads)).toEqual(["Fix UI bug in sidebar"]);
    expect(rankTitles("lint", threads)).toEqual([]);
    // Short words before a mere prefix are a coincidence.
    expect(rankTitles("inth", [thread("Show skill names in thread overview")])).toEqual([]);
    expect(rankTitles("tos", [thread("Move Client State to Server")])).toEqual([]);
    expect(rankTitles("t3co", [thread("T3 Code vs Gemini")])).toEqual(["T3 Code vs Gemini"]);
    expect(rankTitles('"sidebar lag"', [thread("Fix sidebar lag")])).toEqual(["Fix sidebar lag"]);
    // A pasted query with a separate accent mark matches the composed title.
    expect(rankTitles("cafe\u0301", [thread("Café menu")])).toEqual(["Café menu"]);
    // Three letters of the last word are enough, as it is typed.
    expect(rankTitles("gomod", [thread("Migrate to Go modules")])).toEqual([
      "Migrate to Go modules",
    ]);
    // Joined words beat an earlier match inside a word.
    expect(scoreThreadSearch("vscode", thread("Fixvscode and VS Code"), NOW)?.quality).toBe(0.6);
    // A strong match elsewhere does not hide joined words.
    expect(
      rankTitles("vscode", [
        thread("VS Code remote support"),
        thread("Old work", { branch: "vscode", activityAt: NOW - 400 * DAY }),
      ]),
    ).toContain("VS Code remote support");
  });

  it("stores picked queries without splitting an emoji", () => {
    expect(pickedQuery(`${"a".repeat(31)}🚀`)).toBe("a".repeat(31));
    expect(pickedQuery("  Upl ")).toBe("upl");
    // Folded before it is cut, as stored and as compared.
    const spaced = "investigate    workspace thread reset bug";
    expect(pickedQuery(spaced)).toBe(pickedQuery(foldSearchQuery(spaced)));
  });

  it("matches emoji in titles", () => {
    expect(rankTitles("🚀", [thread("🚀 Launch checklist"), thread("Launch notes")])).toEqual([
      "🚀 Launch checklist",
    ]);
  });

  it("treats each Chinese or Japanese character as a word start", () => {
    expect(scoreThreadSearch("搜索", thread("实现全文搜索"), NOW)).not.toBeNull();
    expect(scoreThreadSearch("検索", thread("新しい検索機能"), NOW)).not.toBeNull();
  });
});

describe("scoreThreadSearch with heavy use and loose input", () => {
  it("keeps a whole word on a quiet thread above a mid-word hit on a thread opened daily", () => {
    let opens = recordThreadOpen(null, NOW - 60 * DAY, undefined);
    for (let day = 59; day >= 1; day--) opens = recordThreadOpen(opens, NOW - day * DAY, undefined);
    expect(
      rankTitles("auth", [
        thread("Fix oauth redirect", { activityAt: NOW, opens }),
        thread("Share auth across worktrees", { activityAt: NOW - 90 * DAY }),
      ]),
    ).toEqual(["Share auth across worktrees", "Fix oauth redirect"]);
  });

  it("reads a word and the start of the next typed together, highlighting each part", () => {
    const threads = [thread("Fix sidebar lag"), thread("Unrelated work")];
    expect(rankTitles("fixsid", threads)).toEqual(["Fix sidebar lag"]);
    // A later "F" can start the run.
    expect(rankTitles("fixsid", [thread("Feature: Fix sidebar lag")])).toEqual([
      "Feature: Fix sidebar lag",
    ]);
    expect(scoreThreadSearch("fixsid", threads[0]!, NOW)?.ranges).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    // Initials are not words typed together.
    expect(rankTitles("fsl", threads)).toEqual([]);
  });

  it("finds nothing rather than an unrelated thread when no word matches", () => {
    const threads = [
      thread("Projectless threads without Git"),
      thread("Concern about connection setup"),
      thread("Simplify worktree thread creation"),
      thread("Start a new conversation"),
      thread("Setting up the sentinel"),
      thread("I plan to open source all of lakebed in the next few weeks"),
      thread("Design notes"),
      thread("Link pull request to thread"),
    ];
    for (const query of ["posthog", "cron", "stripe", "gpu", "fxsb", "lint", "deno"]) {
      expect(rankTitles(query, threads), query).toEqual([]);
    }
  });

  it("matches pieces of references that hold a number, and environment names", () => {
    const subject = thread("Trim model lists", {
      id: "thread-5fe6f59c-4976",
      environmentLabel: "BeeBox",
      pullRequests: [
        {
          number: 22889,
          references: ["pingdotgg/t3code#22889", "https://github.com/pingdotgg/t3code/pull/22889"],
        },
      ],
    });
    for (const query of [
      "t3code#22889",
      "github.com/pingdotgg/t3code/pull/22889",
      "https://github.com/pingdotgg/t3code/pull/22889/files",
      "5fe6f59c",
      "beebox",
    ]) {
      expect(scoreThreadSearch(foldSearchQuery(query), subject, NOW), query).not.toBeNull();
    }
    expect(scoreThreadSearch("github.com", subject, NOW)).toBeNull();
    // A number is never cut short.
    for (const query of ["github.com/pingdotgg/t3code/pull/2288", "t3code#2288"]) {
      expect(scoreThreadSearch(foldSearchQuery(query), subject, NOW), query).toBeNull();
    }
  });
});

describe("rankMessageMatches", () => {
  it("merges environments by word match, then picks, then quality and use", () => {
    const subjects = new Map([
      ["a-word", thread("A word")],
      ["a-word-2", thread("A word too")],
      ["b-prefix", thread("B prefix")],
      ["b-recent", thread("B recent", { activityAt: NOW })],
      [
        "b-picked",
        thread("B picked", {
          opens: { openedAt: NOW - DAY, score: 1, picks: [{ query: "needle", at: NOW - DAY }] },
        }),
      ],
    ]);
    // Environment A sent two whole words, environment B a prefix and two more.
    const matches = [
      { key: "a-word", quality: 1 },
      { key: "a-word-2", quality: 1 },
      { key: "b-prefix", quality: 0.8 },
      { key: "b-recent", quality: 1 },
      { key: "b-picked", quality: 0.8 },
    ];
    expect(
      rankMessageMatches(matches, (match) => subjects.get(match.key), "needle", NOW).map(
        (match) => match.key,
      ),
    ).toEqual(["b-picked", "b-recent", "a-word", "a-word-2", "b-prefix"]);
    // A palette lists title matches above, so they use up no message rows.
    const titled = new Map([...subjects, ["c-titled", thread("Needle cleanup")]]);
    expect(
      rankMessageMatches(
        [{ key: "c-titled", quality: 1 }, ...matches],
        (match) => titled.get(match.key),
        "needle",
        NOW,
        { withoutTitleMatches: true },
      ).map((match) => match.key),
    ).not.toContain("c-titled");
  });

  it("ranks a thread that keeps using the word above a passing mention of equal quality", () => {
    // The real case: 21 hits seven weeks back against one this week, opened today.
    const subjects = new Map([
      [
        "mention",
        thread("Mention", {
          activityAt: NOW - 3 * DAY,
          opens: { openedAt: NOW, score: 1, picks: [] },
        }),
      ],
      ["about", thread("About it", { activityAt: NOW - 48 * DAY })],
    ]);
    const matches = [
      { key: "mention", quality: 1, hits: 1 },
      { key: "about", quality: 1, hits: 21 },
    ];
    expect(
      rankMessageMatches(matches, (match) => subjects.get(match.key), "tailscale", NOW).map(
        (match) => match.key,
      ),
    ).toEqual(["about", "mention"]);
  });

  it("keeps matches inside words below word matches, however used", () => {
    const busy = thread("Busy", {
      activityAt: NOW,
      opens: { openedAt: NOW, score: 20, picks: [] },
    });
    const matches = [
      { key: "busy", quality: 0.3 },
      { key: "quiet", quality: 1 },
    ];
    const subjects = new Map([
      ["busy", busy],
      ["quiet", thread("Quiet")],
    ]);
    expect(
      rankMessageMatches(matches, (match) => subjects.get(match.key), "rust", NOW).map(
        (match) => match.key,
      ),
    ).toEqual(["quiet", "busy"]);
  });
});

describe("rankSearchGroups", () => {
  it("orders groups by their best match and keeps the given order on ties", () => {
    const groups = rankSearchGroups(
      [
        { group: "actions", items: ["Open settings", "New thread"] },
        { group: "threads", items: ["Settings sync rewrite", "Thread settings"] },
        { group: "projects", items: ["Settings app"] },
      ],
      (item, options) => scoreSearchTerms("settings", [item], options),
    );
    expect(groups.map(({ group, ranked }) => [group, ranked.map(({ item }) => item)])).toEqual([
      ["actions", ["Open settings"]],
      ["threads", ["Settings sync rewrite", "Thread settings"]],
      ["projects", ["Settings app"]],
    ]);
  });
});

describe("rankSearchGroups with keywords and picks", () => {
  it("matches inside a word only in thread titles", () => {
    expect(scoreSearchTerms("arch", ["Search project contents"])).toBeNull();
    expect(
      scoreThreadSearch("arch", thread("Notes", { branch: "research-extension-system" }), NOW),
    ).toBeNull();
    expect(scoreThreadSearch("arch", thread("Research notes"), NOW)?.quality).toBe(0.3);
  });

  it("forgives typos in names but not in hidden keywords", () => {
    const groups = rankSearchGroups(
      [
        { group: "actions", items: [["Open settings", "preferences", "keybindings"]] },
        { group: "settings", items: [["Keybindings", "General"]] },
      ],
      (terms, options) => scoreSearchTerms("keybindngs", terms, options),
    );
    expect(groups.map(({ group }) => group)).toEqual(["settings"]);
    expect(scoreSearchTerms("duckdb", ["Search engine", "duckduckgo"], { typos: true })).toBeNull();
    expect(scoreSearchTerms("rust", ["GitHub sharing", "trusted"])).toBeNull();
    // Filler words do not make a short query long enough for keyword prefixes.
    expect(scoreSearchTerms("the ci", ["Context window indicator", "circle"])).toBeNull();
  });

  it("lists a thread named for the query above a command with it as a keyword", () => {
    const rank = (command: string[], subject: ThreadSearchSubject) =>
      rankSearchGroups<string, string[] | ThreadSearchSubject, SearchTermsMatch>(
        [
          { group: "actions", items: [command] },
          { group: "threads", items: [subject] },
        ],
        (item, options) => {
          if (Array.isArray(item)) return scoreSearchTerms("mcp", item, options);
          return scoreThreadSearch("mcp", item, NOW, options);
        },
      ).map(({ group }) => group);
    const named = thread("Trim MCP model lists");
    const picked = thread("Trim MCP model lists", {
      opens: { openedAt: NOW, score: 1, picks: [{ query: "mcp", at: NOW }] },
    });
    expect(rank(["Restart agent session", "reload", "mcp"], named)).toEqual(["threads", "actions"]);
    // A command named for the query stays first; a pick reorders threads but
    // never moves their group, so one pick for "mcp" does not pass the command.
    expect(rank(["Reload MCP servers"], named)).toEqual(["actions", "threads"]);
    expect(rank(["Reload MCP servers"], picked)).toEqual(["actions", "threads"]);
  });
});

describe("recordThreadOpen", () => {
  it("decays the open count, merges quick reopens, and keeps the latest picked queries", () => {
    const first = recordThreadOpen(null, NOW, "  Upl ");
    expect(first).toEqual({ openedAt: NOW, score: 1, picks: [{ query: "upl", at: NOW }] });
    const reopened = recordThreadOpen(first, NOW + 60_000, "uploadthing");
    expect(reopened).toEqual({
      openedAt: NOW,
      score: 1,
      picks: [
        { query: "uploadthing", at: NOW + 60_000 },
        { query: "upl", at: NOW },
      ],
    });
    const later = recordThreadOpen(reopened, NOW + SEARCH_RECENCY_HALF_LIFE_MS, "x".repeat(50));
    expect(later.score).toBe(1.5);
    expect(later.picks.map((pick) => pick.query)).toEqual(["x".repeat(32), "uploadthing", "upl"]);
    const repicked = recordThreadOpen(later, later.openedAt + DAY, "upl");
    expect(repicked.picks).toEqual([
      { query: "upl", at: later.openedAt + DAY },
      { query: "x".repeat(32), at: later.openedAt },
      { query: "uploadthing", at: NOW + 60_000 },
    ]);
  });

  it("drops picks that no longer count when the thread is opened again", () => {
    const opens = {
      openedAt: NOW - 30 * DAY,
      score: 1,
      picks: [{ query: "old", at: NOW - 30 * DAY }],
    };
    expect(recordThreadOpen(opens, NOW, "new").picks).toEqual([{ query: "new", at: NOW }]);
  });

  it("does not renew a query's pick when the thread is picked for another one", () => {
    const deploy = [
      thread("Deploy notes", {
        opens: {
          openedAt: NOW,
          score: 2,
          picks: [
            { query: "scripts", at: NOW },
            { query: "deploy", at: NOW - 60 * DAY },
          ],
        },
      }),
      thread("Deploy timeout", {
        opens: { openedAt: NOW - DAY, score: 1, picks: [{ query: "deploy", at: NOW - DAY }] },
      }),
    ];
    expect(rankTitles("deploy", deploy)).toEqual(["Deploy timeout", "Deploy notes"]);
  });
});

describe("findSearchTokenRanges", () => {
  it("maps folded matches back to the source text and skips short tokens", () => {
    const text = "Le Café résumé ci";
    expect(findSearchTokenRanges(text, "CAFE resume ci")).toEqual([
      { start: 3, end: 7 },
      { start: 8, end: 14 },
    ]);
  });

  it("highlights a three-letter token only where it starts a word", () => {
    expect(findSearchTokenRanges("drafts, enableFTS", "fts")).toEqual([{ start: 14, end: 17 }]);
    expect(findSearchTokenRanges("Open handlers.ts", ".ts")).toEqual([{ start: 13, end: 16 }]);
  });
});

describe("scoreMessageMatch", () => {
  it("needs short words at a word start and ranks other words found inside words lower", () => {
    const text = `Saved the drafts. ${"More notes. ".repeat(40)}Then enableFTS and Enable FTS.`;
    const fts = scoreMessageMatch(text, "fts");
    expect(fts?.quality).toBe(1);
    expect(text.slice(fts?.offset)).toMatch(/^FTS and/);
    expect(scoreMessageMatch("saved two drafts", "fts")).toBeNull();
    expect(scoreMessageMatch("We trust the build", "rust")).toEqual({ quality: 0.3, offset: 4 });
    expect(scoreMessageMatch("Rust and trust", "rust")).toEqual({ quality: 1, offset: 0 });
    expect(scoreMessageMatch("Use the sidebar", '"sidebar"')).toEqual({ quality: 1, offset: 8 });
    // Words written together as typed rank above the same words apart, and
    // the snippet starts where they are together.
    const together = "Run the tests, then vp run dev to check";
    expect(scoreMessageMatch(together, "vp run dev")).toEqual({
      quality: 1.25,
      offset: together.indexOf("vp run dev"),
    });
    // Near each other ranks above far apart.
    expect(scoreMessageMatch("dev notes: vp is slow, run it", "vp run dev")?.quality).toBe(1.1);
    const far = `run the tests. ${"More notes. ".repeat(10)}Then dev mode, then vp`;
    expect(scoreMessageMatch(far, "vp run dev")?.quality).toBe(1);
    expect(scoreMessageMatch("I don\u2019t know why", "don't know")?.quality).toBe(1.25);
    expect(scoreMessageMatch("Le Café open late", "cafe open")?.quality).toBe(1.25);
    expect(scoreMessageMatch("The cafe open late", "café open")?.quality).toBe(1.25);
    // The snippet starts where the words meet, not at an early one.
    const phrase = `The plan. ${"More notes. ".repeat(10)}Since the last fix, the sidebar works`;
    expect(scoreMessageMatch(phrase, "fix the sidebar")?.offset).toBe(phrase.indexOf("fix,"));
    const apart = `The lakebed app. ${"Notes. ".repeat(30)}Lakebed page perf is slow`;
    expect(apart.slice(scoreMessageMatch(apart, "lakebed perf")?.offset)).toMatch(/^Lakebed page/);
    // Only where a word counts: not "fix" in "prefix".
    const prefix = `fix ${"unrelated words ".repeat(40)}prefix has CI`;
    expect(scoreMessageMatch(prefix, "fix ci")?.offset).toBe(0);
    // A commit SHA is one word: "cafe" inside one does not match, its start does.
    expect(scoreMessageMatch("see commit 7cafe52bb8", "cafe")).toBeNull();
    expect(scoreMessageMatch("see commit 7cafe52bb8", "7cafe52")).toEqual({
      quality: 1,
      offset: 11,
    });
    expect(scoreMessageMatch("7cafe52bb8, then the cafe", "cafe")?.quality).toBe(1);
    // A whole word beats a word prefix: "mode" prefers "mode" over "model".
    expect(scoreMessageMatch("model settings", "mode")?.quality).toBe(0.8);
    expect(scoreMessageMatch("The model and the mode switch", "mode")).toEqual({
      quality: 1,
      offset: 18,
    });
    expect(scoreMessageMatch("v12rc build", "rc")?.quality).toBe(1);
    expect(scoreMessageMatch("Fix the CLIAdapter state", "ada")?.quality).toBe(0.8);
    // Words too short for the index must start a word too.
    expect(scoreMessageMatch("Switch off the connection", "switch on")).toBeNull();
    expect(scoreMessageMatch("Upgrade pnpm 512 today", "pnpm 12")).toBeNull();
    expect(scoreMessageMatch("Upgrade to pnpm12 today", "pnpm 12")?.quality).toBe(1);
    // A word too short to search only narrows, so typing the next word
    // ("nvme s") does not reorder results; written together still counts.
    expect(scoreMessageMatch("Fix circle rendering", "fix ci")?.quality).toBe(1);
    expect(scoreMessageMatch("Fix CI failures", "fix ci")?.quality).toBe(1.25);
    expect(scoreMessageMatch("Upgrade pnpm 123 today", "pnpm 12")?.quality).toBe(1);
    expect(scoreMessageMatch("Rename the file to index.ts", ".ts")?.quality).toBe(1);
  });

  it("finds words through case and accents, also after the same letters inside a word", () => {
    expect(scoreMessageMatch("This addresses Résumé indexing", "res")).toMatchObject({
      offset: 15,
    });
    expect(scoreMessageMatch("Le CAFÉ ouvert", "cafe")).toMatchObject({ quality: 1, offset: 3 });
    // An accented whole word beats a plain prefix earlier on.
    expect(scoreMessageMatch("The cafeteria, then the Café", "cafe")).toMatchObject({
      quality: 1,
      offset: 24,
    });
    expect(scoreMessageMatch("I presume this. Résumé indexing", "resume")).toMatchObject({
      quality: 1,
      offset: 16,
    });
    expect(scoreMessageMatch("明天部署到生产环境", "部署")).toMatchObject({ offset: 2 });
    // Vietnamese and combining accents fold too.
    expect(scoreMessageMatch("Properties: tiếng Việt support", "tie")).toMatchObject({
      offset: 12,
    });
    expect(scoreMessageMatch("Properties: tie\u0301ng support", "tie")).toMatchObject({
      offset: 12,
    });
    // A letter that grows when lowercased does not shift later offsets.
    expect(scoreMessageMatch("İ Enable fts and model", "fts")).toMatchObject({ offset: 9 });
    expect(scoreMessageMatch("İ Enable fts and model", "model")?.quality).toBe(1);
    expect(scoreMessageMatch("Trip to İstanbul", "İstanbul")).toEqual({ quality: 1, offset: 8 });
  });
});
