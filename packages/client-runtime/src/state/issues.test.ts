// @effect-diagnostics nodeBuiltinImport:off - The retention test forces garbage collection in Node.
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueComment,
  type IssueCommentsPage,
  type IssueDetail,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createIssueCommentPager,
  createMergedIssueCandidatesAtoms,
  createMergedIssueListAtoms,
  issueEntryKey,
  mergeIssueListPage,
  type IssueListTarget,
} from "./issues.ts";

function entry(overrides: Partial<IssueListEntry> & { key: string }): IssueListEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/app",
    displayKey: `#${overrides.key}`,
    title: `Issue ${overrides.key}`,
    url: `https://github.com/acme/app/issues/${overrides.key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: "project-1" as ProjectId,
    projectTitle: "App",
    ...overrides,
  };
}

describe("mergeIssueListPage", () => {
  it("keeps rows from scopes the page did not continue and orders by update", () => {
    const held = [
      entry({ key: "1", updatedAt: "2026-10-03T00:00:00.000Z" }),
      entry({ key: "9", scope: "acme/other", updatedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const page = [entry({ key: "2", updatedAt: "2026-10-04T00:00:00.000Z" })];
    expect(mergeIssueListPage(held, page).map((row) => row.key)).toEqual(["2", "1", "9"]);
  });

  it("replaces a repeated row with the page's newer words", () => {
    const held = [entry({ key: "1", title: "Old title" })];
    const page = [
      entry({ key: "1", title: "New title", state: { category: "closed", name: "closed" } }),
    ];
    const merged = mergeIssueListPage(held, page);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("New title");
    expect(merged[0]?.state.category).toBe("closed");
  });

  it("keys rows case-insensitively by host and scope, exactly by key", () => {
    expect(issueEntryKey(entry({ key: "1", host: "GitHub.com", scope: "Acme/App" }))).toBe(
      issueEntryKey(entry({ key: "1" })),
    );
    expect(issueEntryKey(entry({ key: "ENG-1" }))).not.toBe(issueEntryKey(entry({ key: "eng-1" })));
  });
});

const comment = (id: string): IssueComment => ({
  id,
  author: null,
  body: id,
  createdAt: "2026-10-01T00:00:00.000Z",
  url: null,
});

describe("createIssueCommentPager", () => {
  it("keeps older pages through a failed refresh", async () => {
    const loaded = AsyncResult.success({ comments: [comment("newest")], commentsCursor: "first" });
    const detail =
      Atom.make<AsyncResult.AsyncResult<Pick<IssueDetail, "comments" | "commentsCursor">, string>>(
        loaded,
      );
    const pager = createIssueCommentPager(detail);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(pager.view);
    try {
      await pager.loadOlder(registry, async () =>
        AsyncResult.success({ comments: [comment("older")], nextCursor: null }),
      );
      await pager.refresh(registry, async () => {
        registry.set(detail, AsyncResult.waiting(loaded));
        registry.set(
          detail,
          AsyncResult.failure(Cause.fail("rate limited"), { previousSuccess: Option.some(loaded) }),
        );
      });
      expect(registry.get(pager.view).comments.map(({ id }) => id)).toEqual(["older", "newest"]);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("drops older pages once a refresh lands, including one still loading, and pauses paging until it ends", async () => {
    // The refreshed detail hands back the same cursor, so only the refresh itself can tell pages apart.
    const detail = Atom.make(
      AsyncResult.success({ comments: [comment("newest")], commentsCursor: "first-page" }),
    );
    const pager = createIssueCommentPager(detail);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(pager.view);
    const ids = () => registry.get(pager.view).comments.map(({ id }) => id);
    const cursors: string[] = [];
    const page = AsyncResult.success<IssueCommentsPage>({
      comments: [comment("older"), comment("newest")],
      nextCursor: "second-page",
    });
    const read = async (cursor: string) => {
      cursors.push(cursor);
      return page;
    };
    try {
      await pager.loadOlder(registry, read);
      expect(ids()).toEqual(["older", "newest"]);

      const pending = Promise.withResolvers<typeof page>();
      const inFlight = pager.loadOlder(registry, () => pending.promise);
      const refreshed = Promise.withResolvers<void>();
      const refresh = pager.refresh(registry, async () => {
        await refreshed.promise;
        registry.set(
          detail,
          AsyncResult.success({ comments: [comment("newest")], commentsCursor: "first-page" }),
        );
      });
      pending.resolve(page);
      await inFlight;

      await pager.loadOlder(registry, read);
      expect(registry.get(pager.view).canLoadOlder).toBe(false);
      refreshed.resolve();
      await refresh;
      expect(ids()).toEqual(["newest"]);
      await pager.loadOlder(registry, read);
      expect(cursors).toEqual(["first-page", "first-page"]);
      expect(ids()).toEqual(["older", "newest"]);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("discards loaded and late older pages after refreshing unchanged detail", async () => {
    const value = { comments: [comment("newest")], commentsCursor: "first" };
    const detail = Atom.make(AsyncResult.success(value));
    const pager = createIssueCommentPager(detail);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(pager.view);
    const pending = Promise.withResolvers<AsyncResult.Success<IssueCommentsPage>>();
    try {
      await pager.loadOlder(registry, async () =>
        AsyncResult.success({ comments: [comment("older")], nextCursor: "second" }),
      );
      const inFlight = pager.loadOlder(registry, () => pending.promise);
      await pager.refresh(registry, async () => {
        registry.set(detail, AsyncResult.waiting(registry.get(detail)));
        registry.set(detail, AsyncResult.success(value));
      });
      const afterRefresh = registry.get(pager.view);

      pending.resolve(AsyncResult.success({ comments: [comment("oldest")], nextCursor: null }));
      await inFlight;

      expect(afterRefresh.comments.map(({ id }) => id)).toEqual(["newest"]);
      const settled = registry.get(pager.view);
      expect(settled.comments.map(({ id }) => id)).toEqual(["newest"]);
      expect(settled.nextCursor).toBe("first");
      expect(settled.canLoadOlder).toBe(true);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

describe("createMergedIssueCandidatesAtoms", () => {
  it("retries only failed scopes that are not already reloading", () => {
    const registry = AtomRegistry.make();
    const target = (scope: string) => ({
      environmentId: EnvironmentId.make("issues"),
      input: {
        projectId: ProjectId.make(scope),
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope,
      },
    });
    const targets = [target("acme/healthy"), target("acme/flaky")];
    const requests: string[] = [];
    const candidates = Atom.family((scope: string) =>
      Atom.make(
        Effect.suspend(() => {
          requests.push(scope);
          if (scope === "acme/healthy") {
            return Effect.succeed({ labels: [], assignees: [], truncated: false });
          }
          return requests.length === 2 ? Effect.fail("Repository unavailable") : Effect.never;
        }),
      ),
    );
    const merged = createMergedIssueCandidatesAtoms(
      (t) => candidates(t.input.scope),
      () => "Repository unavailable",
    );
    const view = merged.atom(targets);
    const unmount = registry.mount(view);
    try {
      expect(registry.get(view)).toMatchObject({
        error: "Repository unavailable",
        isPending: false,
      });

      merged.retry(registry, targets);
      expect(registry.get(view).isPending).toBe(true);
      merged.retry(registry, targets);

      expect(requests).toEqual(["acme/healthy", "acme/flaky", "acme/flaky"]);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

describe("createMergedIssueListAtoms", () => {
  const answer: IssueListResult = {
    viewers: {},
    trackers: [],
    entries: [],
    errors: [],
    nextCursors: {},
  };

  it("refreshes the open listings of the environment written to", () => {
    const reads = new Map<string, number>();
    const lists = new Map<string, Atom.Atom<AsyncResult.AsyncResult<IssueListResult>>>();
    const listings = createMergedIssueListAtoms((target) => {
      const key = `${target.environmentId}:${target.input.query}`;
      const existing = lists.get(key);
      if (existing !== undefined) return existing;
      const atom = Atom.make(() => {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return AsyncResult.success(answer);
      });
      lists.set(key, atom);
      return atom;
    }, String);
    const registry = AtomRegistry.make();
    const written = EnvironmentId.make("written");
    const other = EnvironmentId.make("other");
    try {
      const listing = listings.atom([
        { environmentId: written, input: { state: "open", query: "bug" } },
        { environmentId: other, input: { state: "open", query: "bug" } },
      ]);
      registry.mount(listing);

      listings.refreshEnvironment(registry, written);
      registry.get(listing);
      expect(Object.fromEntries(reads)).toEqual({ "written:bug": 2, "other:bug": 1 });
    } finally {
      registry.dispose();
    }
  });

  it("retries only failed environments, leaving one still loading to finish", () => {
    const registry = AtomRegistry.make();
    const targets = ["slow", "flaky"].map((environmentId) => ({
      environmentId: EnvironmentId.make(environmentId),
      input: { state: "open" as const },
    }));
    const requests: string[] = [];
    const lists = Atom.family((environmentId: string) =>
      Atom.make(
        Effect.suspend(() => {
          requests.push(environmentId);
          return environmentId === "flaky" ? Effect.fail("Tracker unavailable") : Effect.never;
        }),
      ),
    );
    const listings = createMergedIssueListAtoms(
      (target) => lists(target.environmentId),
      () => "Tracker unavailable",
    );
    const view = listings.atom(targets);
    const unmount = registry.mount(view);
    try {
      expect(registry.get(view)).toMatchObject({ error: "Tracker unavailable", isPending: true });

      listings.retry(registry, targets);

      expect(requests).toEqual(["slow", "flaky", "flaky"]);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("releases historical search targets when the list closes", async () => {
    NodeV8.setFlagsFromString("--expose-gc");
    const gc = NodeVM.runInNewContext("gc") as () => void;
    const listings = createMergedIssueListAtoms(
      () => Atom.make(AsyncResult.success(answer)),
      String,
    );
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("environment");
    try {
      const historical = ["search-one", "search-two", "search-three"].map((query) => {
        const targets = [
          { environmentId, input: { state: "open", query } },
        ] satisfies IssueListTarget[];
        const close = registry.mount(listings.atom(targets));
        close();
        return new WeakRef(targets);
      });
      // Let the registry remove all three unmounted queries and the WeakRefs leave their creation job.
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
      await NodeTimersPromises.setImmediate();
      gc();

      listings.refreshEnvironment(registry, environmentId);
      expect(
        historical.filter((target) => target.deref() !== undefined).length,
        "historical issue searches retained after closing",
      ).toBe(0);
    } finally {
      registry.dispose();
    }
  });
});
