import {
  ProjectId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  legacyThreadPullRequestKey,
  threadPullRequestSearchTerms,
  resolveThreadCurrentPullRequest,
  resolveThreadPullRequestChains,
  resolveThreadPullRequestBadge,
  threadPullRequestKeysEqual,
} from "./threadPullRequests.ts";

// Remove ES2023 array methods to match Hermes on mobile.
beforeEach(() => {
  const methods = ["toSorted", "toReversed", "toSpliced"] as const;
  const descriptors = methods.map((method) =>
    Object.getOwnPropertyDescriptor(Array.prototype, method),
  );
  for (const method of methods) Reflect.deleteProperty(Array.prototype, method);
  return () => {
    for (const [index, method] of methods.entries()) {
      const descriptor = descriptors[index];
      if (descriptor) Reflect.defineProperty(Array.prototype, method, descriptor);
    }
  };
});

function snapshot(input: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Change",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    syncedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function link(
  number: number,
  input: Partial<Omit<ThreadPullRequestLink, "number">> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: `2026-01-01T00:00:${String(number).padStart(2, "0")}.000Z`,
    snapshot: null,
    stack: null,
    ...input,
  };
}

describe("threadPullRequestKeysEqual", () => {
  it("recovers Forgejo ports from old stored URLs and keeps separate servers distinct", () => {
    const old = link(1, {
      host: "forge.example",
      repository: "team/repo",
      url: "http://forge.example:3000/team/repo/pulls/1",
    });
    expect(threadPullRequestKeysEqual(old, { ...old, host: "forge.example:3000" })).toBe(true);
    expect(
      threadPullRequestKeysEqual(old, {
        host: "forge.example:3000",
        repository: "team/repo",
        number: 1,
      }),
    ).toBe(true);
    expect(
      threadPullRequestKeysEqual(old, {
        ...old,
        url: "http://forge.example:4000/team/repo/pulls/1",
      }),
    ).toBe(false);
  });

  it("recovers Azure repository keys from stored URLs", () => {
    const own = link(7, {
      host: "dev.azure.com",
      repository: "org-a/project/_git/web",
      url: "https://dev.azure.com/org-a/project/_git/web/pullrequest/7",
    });
    expect(legacyThreadPullRequestKey({ ...own, repository: "web" })).toEqual({
      host: "dev.azure.com",
      repository: "org-a/project/_git/web",
      number: 7,
    });
    expect(
      threadPullRequestKeysEqual(own, {
        host: "org-a.visualstudio.com",
        repository: "DefaultCollection/project/_git/web",
        number: 7,
      }),
    ).toBe(true);
  });
});

describe("resolveThreadCurrentPullRequest", () => {
  it("prefers the single open link over terminal ones", () => {
    const current = resolveThreadCurrentPullRequest([
      link(1, { snapshot: snapshot({ state: "merged" }) }),
      link(2, { snapshot: snapshot({ state: "open" }) }),
      link(3, { snapshot: snapshot({ state: "closed" }) }),
    ]);
    expect(current).toMatchObject({ kind: "single", link: { number: 2 } });
  });

  it("reports a stack when several links are open and puts the highest layer on top", () => {
    const stack = {
      kind: "native" as const,
      id: "s1",
      number: 1,
      url: "https://github.com/pingdotgg/t3code/stacks/1",
      base: "main",
      layers: [
        { number: 10, headBranch: "a", state: "open" as const },
        { number: 11, headBranch: "b", state: "open" as const },
      ],
    };
    const current = resolveThreadCurrentPullRequest([
      link(11, { snapshot: snapshot(), stack }),
      link(10, { snapshot: snapshot(), stack }),
    ]);
    expect(current).toMatchObject({ kind: "stack", top: { number: 11 } });
    if (current?.kind === "stack") {
      expect(current.open.map((entry) => entry.number)).toEqual([11, 10]);
    }
  });

  it("orders an open set without stack data by most recent link", () => {
    const current = resolveThreadCurrentPullRequest([link(1), link(2)]);
    expect(current).toMatchObject({ kind: "stack", top: { number: 2 } });
  });

  it("falls back to the most recently updated terminal link", () => {
    const current = resolveThreadCurrentPullRequest([
      link(1, { snapshot: snapshot({ state: "merged", updatedAt: "2026-01-03T00:00:00.000Z" }) }),
      link(2, { snapshot: snapshot({ state: "closed", updatedAt: "2026-01-02T00:00:00.000Z" }) }),
    ]);
    expect(current).toMatchObject({ kind: "single", link: { number: 1 } });
  });
});

describe("resolveThreadPullRequestChains", () => {
  it("chains links by base → head within a repository, bottom to top", () => {
    const chains = resolveThreadPullRequestChains([
      link(3, { snapshot: snapshot({ headBranch: "c", baseBranch: "b" }) }),
      link(1, { snapshot: snapshot({ headBranch: "a", baseBranch: "main" }) }),
      link(2, { snapshot: snapshot({ headBranch: "b", baseBranch: "a" }) }),
      link(9, { snapshot: snapshot({ headBranch: "solo", baseBranch: "main" }) }),
    ]);
    expect(chains.map((chain) => [chain.kind, chain.layers.map((layer) => layer.number)])).toEqual([
      ["derived", [1, 2, 3]],
      ["derived", [9]],
    ]);
  });

  it("keeps every link built on the same parent under it", () => {
    const links = [
      link(3, { snapshot: snapshot({ headBranch: "c", baseBranch: "a" }) }),
      link(5, { snapshot: snapshot({ headBranch: "p", baseBranch: "main" }) }),
      link(6, { snapshot: snapshot({ headBranch: "q", baseBranch: "p" }) }),
      link(1, { snapshot: snapshot({ headBranch: "a", baseBranch: "p" }) }),
      link(2, { snapshot: snapshot({ headBranch: "b", baseBranch: "a" }) }),
      link(9, { snapshot: snapshot({ headBranch: "solo", baseBranch: "main" }) }),
    ];
    const chains = resolveThreadPullRequestChains(links);
    expect(
      chains.map((chain) => [chain.layers.map((layer) => layer.number), chain.depths]),
    ).toEqual([
      [
        [5, 6, 1, 3, 2],
        [0, 1, 1, 2, 2],
      ],
      [[9], [0]],
    ]);
    expect(resolveThreadPullRequestBadge(links.slice(0, 5))).toEqual({
      kind: "stack",
      layers: 5,
      state: "open",
    });
  });

  it("points at the highest layer of a branched stack, not the last sibling listed", () => {
    const branched = (state: ThreadPullRequestSnapshot["state"]) => [
      link(1, { snapshot: snapshot({ state, headBranch: "a" }) }),
      link(2, { snapshot: snapshot({ state, headBranch: "b", baseBranch: "a" }) }),
      link(3, { snapshot: snapshot({ state, headBranch: "c", baseBranch: "b" }) }),
      link(4, { snapshot: snapshot({ state, headBranch: "d", baseBranch: "a" }) }),
    ];
    const open = resolveThreadCurrentPullRequest(branched("open"));
    expect(open?.kind === "stack" ? open.open.map((entry) => entry.number) : null).toEqual([
      3, 4, 2, 1,
    ]);
    expect(resolveThreadCurrentPullRequest(branched("merged"))).toMatchObject({
      kind: "single",
      link: { number: 3 },
    });
  });

  it("uses a later complete native snapshot for layer order and the current pull request", () => {
    const links = [18, 20, 83, 84].map((number) =>
      link(number, {
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: snapshot(),
        stack: {
          kind: "native",
          id: "80",
          number: 80,
          url: "https://github.com/pingdotgg/t3code/stacks/80",
          base: "main",
          layers: (number < 83
            ? [79, 37, 38, 39, 76, 18, 20]
            : [79, 37, 38, 39, 76, 18, 20, 83, 84]
          ).map((number) => ({ number, headBranch: `pr-${number}`, state: "open" })),
        },
      }),
    );
    expect
      .soft(
        resolveThreadPullRequestChains(links).map((chain) =>
          chain.layers.map((layer) => layer.number),
        ),
      )
      .toEqual([[18, 20, 83, 84]]);
    expect(resolveThreadCurrentPullRequest(links)).toMatchObject({
      kind: "stack",
      top: { number: 84 },
      open: [{ number: 84 }, { number: 83 }, { number: 20 }, { number: 18 }],
    });
  });

  it("uses the earliest longest partial snapshot and appends missing members in stored order", () => {
    const links = [
      [3, 2],
      [9, 2, 3],
      [9, 3, 2],
      [9, 3, 2],
    ].map((numbers, index) =>
      link(index + 1, {
        stack: {
          kind: "native",
          id: "s1",
          number: 1,
          url: "https://github.com/pingdotgg/t3code/stacks/1",
          base: "main",
          layers: numbers.map((number) => ({ number, headBranch: `pr-${number}`, state: "open" })),
        },
      }),
    );
    expect(
      resolveThreadPullRequestChains(links).map((chain) =>
        chain.layers.map((layer) => layer.number),
      ),
    ).toEqual([[2, 3, 1, 4]]);
  });

  it("uses the native stack order when the host provides one", () => {
    const stack = {
      kind: "native" as const,
      id: "s1",
      number: 1,
      url: "https://github.com/pingdotgg/t3code/stacks/1",
      base: "main",
      layers: [
        { number: 5, headBranch: "a", state: "merged" as const },
        { number: 6, headBranch: "b", state: "open" as const },
      ],
    };
    const chains = resolveThreadPullRequestChains([
      link(6, { snapshot: snapshot({ headBranch: "b", baseBranch: "main" }), stack }),
      link(5, {
        snapshot: snapshot({ state: "merged", headBranch: "a", baseBranch: "main" }),
        stack,
      }),
      link(8),
    ]);
    expect(chains.map((chain) => [chain.kind, chain.layers.map((layer) => layer.number)])).toEqual([
      ["native", [5, 6]],
      ["derived", [8]],
    ]);
  });
});

describe("chain selection and badge state", () => {
  it.each(["open", "merged", "closed"] as const)(
    "targets the top of a derived %s chain despite a later bottom update and link",
    (state) => {
      const bottom = link(2, {
        snapshot: snapshot({ state, headBranch: "base", updatedAt: "2026-02-01T00:00:00.000Z" }),
      });
      const top = link(1, {
        snapshot: snapshot({ state, headBranch: "top", baseBranch: "base" }),
      });
      expect(resolveThreadCurrentPullRequest([bottom, top])).toMatchObject(
        state === "open"
          ? { kind: "stack", top: { number: 1 }, open: [top, bottom] }
          : { kind: "single", link: { number: 1 } },
      );
      expect(resolveThreadPullRequestBadge([bottom, top])).toEqual({
        kind: "stack",
        layers: 2,
        state,
      });
    },
  );

  it("keeps the top native layer after completion and treats an unsynced layer as open", () => {
    const stack = {
      kind: "native" as const,
      id: "native-1",
      number: 1,
      url: "https://github.com/pingdotgg/t3code/stacks/1",
      base: "main",
      layers: [
        { number: 2, headBranch: "base", state: "merged" as const },
        { number: 1, headBranch: "top", state: "merged" as const },
      ],
    };
    const bottom = link(2, {
      stack,
      snapshot: snapshot({ state: "merged", updatedAt: "2026-02-01T00:00:00.000Z" }),
    });
    const top = link(1, { stack, snapshot: snapshot({ state: "merged" }) });
    expect(resolveThreadCurrentPullRequest([bottom, top])).toMatchObject({
      kind: "single",
      link: { number: 1 },
    });
    expect(resolveThreadPullRequestBadge([bottom, { ...top, snapshot: null }])).toEqual({
      kind: "stack",
      layers: 2,
      state: "open",
    });
  });

  it("uses aggregate state and distinguishes unrelated work from a stack", () => {
    const bottom = link(1, { snapshot: snapshot({ state: "merged", headBranch: "base" }) });
    const top = link(2, { snapshot: snapshot({ state: "closed", baseBranch: "base" }) });
    expect(resolveThreadPullRequestBadge([bottom, top])).toEqual({
      kind: "stack",
      layers: 2,
      state: "closed",
    });
    expect(resolveThreadPullRequestBadge([bottom, top, link(3)])).toEqual({
      kind: "pull-request",
      others: 2,
      state: "open",
    });
    expect(resolveThreadPullRequestBadge([link(3, { source: "stack-dismissed" })])).toBeNull();
  });

  it("keeps branch matching case-sensitive while ignoring repository case", () => {
    const bottom = link(1, {
      repository: "PingDotGG/T3code",
      snapshot: snapshot({ headBranch: "Base" }),
    });
    const top = link(2, { snapshot: snapshot({ headBranch: "top", baseBranch: "base" }) });
    expect(resolveThreadPullRequestChains([bottom, top])).toHaveLength(2);
    expect(
      resolveThreadPullRequestChains([
        bottom,
        { ...top, snapshot: snapshot({ headBranch: "top", baseBranch: "Base" }) },
      ])[0]?.layers,
    ).toEqual([bottom, { ...top, snapshot: snapshot({ headBranch: "top", baseBranch: "Base" }) }]);
  });

  it("preserves cyclic links without presenting a guessed stack order", () => {
    const links = [
      link(1, { snapshot: snapshot({ headBranch: "a", baseBranch: "b" }) }),
      link(2, { snapshot: snapshot({ headBranch: "b", baseBranch: "a" }) }),
    ];
    expect(resolveThreadPullRequestChains(links).map((chain) => chain.layers)).toEqual(
      links.map((entry) => [entry]),
    );
    expect(resolveThreadCurrentPullRequest(links)).toMatchObject({
      kind: "stack",
      top: { number: 2 },
    });
    expect(resolveThreadPullRequestBadge(links)).toEqual({
      kind: "pull-request",
      others: 1,
      state: "open",
    });
  });

  it("lists a pull request once when two links share its identity", () => {
    const links = [
      link(1, { snapshot: snapshot({ headBranch: "a" }) }),
      link(1, { snapshot: snapshot({ headBranch: "b", baseBranch: "a" }) }),
      link(1, { snapshot: snapshot({ headBranch: "c" }) }),
    ];
    expect(resolveThreadPullRequestChains(links).map((chain) => chain.layers)).toEqual([
      [links[0]],
    ]);
  });

  it("does not guess a parent when a head branch was reused", () => {
    const links = [
      link(1, { snapshot: snapshot({ state: "merged", headBranch: "reused" }) }),
      link(2, { snapshot: snapshot({ headBranch: "reused" }) }),
      link(3, { snapshot: snapshot({ headBranch: "top", baseBranch: "reused" }) }),
    ];
    expect(resolveThreadPullRequestChains(links).map((chain) => chain.layers)).toEqual(
      links.map((entry) => [entry]),
    );
  });
});

describe("threadPullRequestSearchTerms", () => {
  it("includes completed and unsynced links but excludes dismissed links", () => {
    const terms = threadPullRequestSearchTerms({
      pullRequests: [
        link(12, { snapshot: snapshot({ title: "Fix login", state: "merged" }) }),
        link(34),
        link(56, { source: "stack-dismissed" }),
      ],
    });
    expect(terms).toContain("#12");
    expect(terms).toContain("pingdotgg/t3code#12");
    expect(terms).toContain("https://github.com/pingdotgg/t3code/pull/12");
    expect(terms).toContain("Fix login");
    expect(terms).toContain("#34");
    expect(terms.join(" ")).not.toContain("56");
  });
});

it("searches the legacy projection when old environments decode to an empty links list", () => {
  const linkedPullRequest = {
    projectId: ProjectId.make("project"),
    repository: "pingdotgg/t3code",
    number: 12,
    url: "https://github.com/pingdotgg/t3code/pull/12",
  };
  expect(threadPullRequestSearchTerms({ pullRequests: [], linkedPullRequest })).toContain("#12");
  expect(
    threadPullRequestSearchTerms({ pullRequests: [link(34)], linkedPullRequest }),
  ).not.toContain("#12");
});
