import type {
  EnvironmentId,
  AuthSessionState,
  IssueCapabilities,
  IssueCommentsPageInput,
  IssueListEntry,
  IssueListResult,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { AuthOrchestrationReadScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import * as Session from "./session.ts";
import * as RpcClient from "../rpc/client.ts";
import { executeAtomQuery } from "./runtime.ts";

import {
  continueIssueListPage,
  createIssueEnvironmentAtoms,
  createIssueSourceRefreshQueue,
  holdIssueListAnswer,
  readIssueListSourcePage,
  issueEntryKey,
  issueListCursorsOn,
  issueScopeKey,
  issueSourceMatchesList,
  mergeIssueListPage,
  offeredIssueInvolvements,
  refreshIssueListPage,
} from "./issues.ts";

describe("issueSourceMatchesList", () => {
  const source = { projectId: "one" as ProjectId, host: "jira.example.com" };
  it("keeps refreshes from another project or host outside the filtered list", () => {
    expect(issueSourceMatchesList({ state: "all", projectId: "two" as ProjectId }, source)).toBe(
      false,
    );
    expect(issueSourceMatchesList({ state: "open", host: "github.com" }, source)).toBe(false);
  });
  it("refreshes a matching source and leaves state and involvement filtering to the server", () => {
    expect(
      issueSourceMatchesList(
        {
          state: "closed",
          involvement: "assigned",
          projectId: source.projectId,
          host: "JIRA.EXAMPLE.COM",
        },
        source,
      ),
    ).toBe(true);
    expect(issueSourceMatchesList({ state: "all" }, source)).toBe(true);
  });
});

describe("issue comment requests", () => {
  it.each([
    { host: "second.atlassian.net" },
    { tracker: "github" as IssueTrackerKind },
    { host: undefined },
    { cursor: "next" },
    { viewer: "native-viewer" },
    {},
  ])("keeps single-flight requests distinct for %j", async (change) => {
    const input: IssueCommentsPageInput = {
      projectId: "project-1" as ProjectId,
      tracker: "jira" as IssueTrackerKind,
      host: "first.atlassian.net",
      scope: "ENG",
      key: "ENG-1",
      cursor: "older",
    };
    const secondInput = { ...input, ...change };
    const latch = Latch.makeUnsafe();
    const started = Promise.withResolvers<void>();
    const calls: IssueCommentsPageInput[] = [];
    const request = vi.spyOn(RpcClient, "requestGuarded");
    request.mockImplementation(((_tag: string, payload: IssueCommentsPageInput) =>
      Effect.sync(() => {
        calls.push(payload);
        started.resolve();
      }).pipe(
        Effect.andThen(latch.await),
        Effect.as({ comments: [], nextCursor: JSON.stringify(payload) }),
      )) as unknown as Parameters<typeof request.mockImplementation>[0]);
    const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_environmentId, effect) =>
        Effect.provideService(
          effect,
          EnvironmentSupervisor.EnvironmentSupervisor,
          {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
        ),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
    );
    const atoms = createIssueEnvironmentAtoms(runtime);
    const registry = AtomRegistry.make();
    const environmentId = "environment-1" as EnvironmentId;

    try {
      const first = atoms.comments.run(registry, { environmentId, input });
      await started.promise;
      const second = atoms.comments.run(registry, { environmentId, input: secondInput });
      latch.openUnsafe();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({
        _tag: "Success",
        value: { nextCursor: JSON.stringify(input) },
      });
      expect(secondResult).toMatchObject({
        _tag: "Success",
        value: { nextCursor: JSON.stringify(secondInput) },
      });
      expect(calls).toEqual(Object.keys(change).length === 0 ? [input] : [input, secondInput]);
    } finally {
      registry.dispose();
      request.mockRestore();
    }
  });
});

function issueReadHarness() {
  const supervisor = {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_environmentId, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    ),
  );
  const session = Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
      permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
    } satisfies AuthSessionState),
  );
  const sessions = Session.createEnvironmentSessionAtoms(runtime);
  const sessionFactory = vi
    .spyOn(Session, "createEnvironmentSessionAtoms")
    .mockReturnValue({ ...sessions, sessionStateAtom: () => session });
  const registry = AtomRegistry.make();
  return {
    runtime,
    atoms: createIssueEnvironmentAtoms(runtime),
    registry,
    dispose: () => {
      registry.dispose();
      sessionFactory.mockRestore();
    },
  };
}

const issueListResult = (title: string): IssueListResult => ({
  entries: [entry({ key: "1", title })],
  viewers: {},
  trackers: [],
  nextCursors: {},
  errors: [],
});

describe("post-write issue reads", () => {
  it.effect("keeps identical page reads separate after two writes", () =>
    Effect.gen(function* () {
      const { atoms, registry, dispose } = issueReadHarness();
      const started = Deferred.makeUnsafe<void>();
      const firstResponse = Deferred.makeUnsafe<IssueListResult>();
      let calls = 0;
      const request = vi.spyOn(RpcClient, "requestGuarded");
      request.mockImplementation((() =>
        Effect.suspend(() => {
          calls += 1;
          if (calls === 1) {
            Deferred.doneUnsafe(started, Exit.void);
            return Deferred.await(firstResponse);
          }
          return Effect.succeed(issueListResult("After second write"));
        })) as unknown as Parameters<typeof request.mockImplementation>[0]);
      const target = {
        environmentId: "environment-1" as EnvironmentId,
        input: { state: "open" as const, projectId: "project-1" as ProjectId },
      };
      try {
        const first = atoms.listPage.run(registry, target);
        yield* Deferred.await(started);
        const second = atoms.listPage.run(registry, target);
        Deferred.doneUnsafe(firstResponse, Exit.succeed(issueListResult("After first write")));
        expect(yield* Effect.promise(() => first)).toMatchObject({
          _tag: "Success",
          value: { entries: [{ title: "After first write" }] },
        });
        expect(yield* Effect.promise(() => second)).toMatchObject({
          _tag: "Success",
          value: { entries: [{ title: "After second write" }] },
        });
        expect(calls).toBe(2);
      } finally {
        dispose();
        request.mockRestore();
      }
    }),
  );

  it.effect.each(["full first", "scoped first", "two writes"])(
    "keeps the newest source after %s",
    (order) =>
      Effect.gen(function* () {
        const { atoms, runtime, registry, dispose } = issueReadHarness();
        const fullStarted = Deferred.makeUnsafe<void>();
        const sourceStarted = Deferred.makeUnsafe<void>();
        const rejectedSource = Deferred.makeUnsafe<void>();
        const oldFull = Deferred.makeUnsafe<IssueListResult>();
        const oldSource = Deferred.makeUnsafe<IssueListResult>();
        let fullCalls = 0;
        let sourceCalls = 0;
        let revision = 1;
        const cached = Atom.make({
          answer: null as IssueListResult | null,
          page: issueListResult("Before writes"),
        });
        const request = vi.spyOn(RpcClient, "requestGuarded");
        request.mockImplementation(((tag: string, input: { projectId?: string }) =>
          Effect.suspend(() => {
            if (tag === "issues.setState") return Effect.void;
            if (input.projectId === undefined) {
              fullCalls += 1;
              if (fullCalls === 1) return Effect.succeed(issueListResult("Before writes"));
              Deferred.doneUnsafe(fullStarted, Exit.void);
              return Deferred.await(oldFull);
            }
            sourceCalls += 1;
            if (sourceCalls === 1) {
              Deferred.doneUnsafe(sourceStarted, Exit.void);
              return Deferred.await(oldSource);
            }
            return Effect.succeed(
              order === "two writes"
                ? { ...issueListResult("Newest write"), entries: [] }
                : issueListResult("Newest write"),
            );
          })) as unknown as Parameters<typeof request.mockImplementation>[0]);
        const query = runtime.atom(RpcClient.requestGuarded("issues.list", { state: "open" }));
        const visible = Atom.make((get) => {
          const full = get(query);
          const stored = get(cached);
          return full._tag === "Success" && full.value !== stored.answer ? full.value : stored.page;
        });
        const queue = createIssueSourceRefreshQueue();
        let writes = 0;
        const write = () =>
          atoms.setState.run(registry, {
            environmentId: "environment-1" as EnvironmentId,
            input: {
              projectId: "project-1" as ProjectId,
              tracker: "github" as IssueTrackerKind,
              scope: "acme/app",
              key: String(++writes),
              state: "closed",
            },
          });
        const committed: string[] = [];
        const read = async () => {
          const startedRevision = revision;
          const response = await readIssueListSourcePage(registry, query, () =>
            atoms.listPage.run(registry, {
              environmentId: "environment-1" as EnvironmentId,
              input: { state: "open", projectId: "project-1" as ProjectId },
            }),
          );
          if (revision !== startedRevision) return;
          if (!response.isCurrent()) {
            Deferred.doneUnsafe(rejectedSource, Exit.void);
            void queue("source", read);
            return;
          }
          if (response.result._tag === "Success") {
            registry.set(cached, { answer: response.answer, page: response.result.value });
            committed.push(response.result.value.entries[0]?.title ?? "empty");
          }
        };
        try {
          yield* Effect.promise(() => executeAtomQuery(registry, query));
          if (order === "two writes") expect((yield* Effect.promise(write))._tag).toBe("Success");
          const refresh = queue("source", read);
          yield* Deferred.await(sourceStarted);
          if (order === "two writes") {
            expect((yield* Effect.promise(write))._tag).toBe("Success");
            revision += 1;
            void queue("source", read);
          } else {
            const full = executeAtomQuery(registry, query, { refresh: true });
            yield* Deferred.await(fullStarted);
            if (order === "full first") {
              Deferred.doneUnsafe(oldFull, Exit.succeed(issueListResult("Old full read")));
              yield* Effect.promise(() => full);
            } else {
              Deferred.doneUnsafe(oldSource, Exit.succeed(issueListResult("After write")));
              yield* Deferred.await(rejectedSource);
              expect(registry.get(visible).entries[0]?.title).toBe("Before writes");
              Deferred.doneUnsafe(oldFull, Exit.succeed(issueListResult("Old full read")));
              yield* Effect.promise(() => full);
            }
          }
          Deferred.doneUnsafe(oldSource, Exit.succeed(issueListResult("After write")));
          yield* Effect.promise(() => refresh);
          if (order === "two writes") expect(registry.get(visible).entries).toEqual([]);
          else expect(registry.get(visible).entries[0]?.title).toBe("Newest write");
          expect(committed).toEqual([order === "two writes" ? "empty" : "Newest write"]);
          expect(writes).toBe(order === "two writes" ? 2 : 0);
          expect(sourceCalls).toBe(2);
          expect(fullCalls).toBe(order === "two writes" ? 1 : 2);
        } finally {
          dispose();
          request.mockRestore();
        }
      }),
  );
});

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

describe("issue list continuations", () => {
  it("continues a held answer only through its own first cursor object", () => {
    const cursor = "github.com acme/app";
    const answer: IssueListResult = {
      entries: [entry({ key: "1" })],
      viewers: {},
      trackers: [],
      nextCursors: { [cursor]: "2" },
      errors: [],
    };
    const held = holdIssueListAnswer(answer);
    expect(held.firstCursors).toBe(answer.nextCursors);
    const page = { entries: [entry({ key: "2" })], nextCursors: {}, errors: [] };
    expect(continueIssueListPage(held, held.nextCursors, page, { ...answer.nextCursors })).toBe(
      held,
    );
    const continued = continueIssueListPage(held, held.nextCursors, page, answer.nextCursors);
    expect(continued.entries.map((row) => row.key)).toEqual(["1", "2"]);
    expect(continued.nextCursors).toEqual({});
    expect(continued.answer).toBe(answer);
  });

  it("keeps a failed scope's cursor when an older server omits error host and tracker", () => {
    const held = {
      entries: [entry({ key: "1" })],
      nextCursors: { "github.com acme/app": "2" },
      firstCursors: { "github.com acme/app": "2" },
      firstKeys: new Set([issueEntryKey(entry({ key: "1" }))]),
      errors: [],
    };
    const failed = {
      entries: [],
      nextCursors: {},
      errors: [{ projectId: "project-1" as ProjectId, projectTitle: "App", message: "down" }],
    };
    const continued = continueIssueListPage(held, held.nextCursors, failed, held.firstCursors);
    expect(continued.nextCursors).toEqual(held.nextCursors);
    const refreshed = refreshIssueListPage(held, failed);
    expect(refreshed.entries).toEqual(held.entries);
    expect(refreshed.nextCursors).toEqual(held.nextCursors);
    const retried = continueIssueListPage(
      continued,
      continued.nextCursors,
      { entries: [entry({ key: "2" })], nextCursors: {}, errors: [] },
      continued.firstCursors,
    );
    expect(retried.entries).toHaveLength(2);
    expect(retried.errors).toEqual([]);
    expect(retried.nextCursors).toEqual({});
  });

  const cursors = {
    "github.com acme/app": "a",
    "github.com acme/other": "b",
    "linear.app ENG": "c",
  };

  it("keeps same-host trackers separate through retries and source refresh", () => {
    const github = entry({ key: "1", host: "shared.example" });
    const gitlab = entry({ ...github, tracker: "gitlab" as IssueTrackerKind });
    const gh = "github shared.example acme/app";
    const gl = "gitlab shared.example acme/app";
    const held = {
      entries: [github, gitlab],
      nextCursors: { [gh]: "gh2", [gl]: "gl2" },
      firstCursors: { [gh]: "gh2", [gl]: "gl2" },
      firstKeys: new Set([github, gitlab].map(issueEntryKey)),
      errors: [] as IssueListResult["errors"],
    };
    expect(mergeIssueListPage([github], [gitlab])).toHaveLength(2);
    expect(issueListCursorsOn(held.nextCursors, "Shared.Example", "gitlab")).toEqual({
      [gl]: "gl2",
    });
    const down = {
      projectId: gitlab.projectId,
      projectTitle: "App",
      tracker: gitlab.tracker,
      host: gitlab.host,
      message: "down",
    };
    const failed = continueIssueListPage(
      held,
      { [gl]: "gl2" },
      { entries: [], nextCursors: {}, errors: [down] },
      held.firstCursors,
    );
    expect(failed.nextCursors).toEqual(held.nextCursors);
    const continued = continueIssueListPage(
      failed,
      { [gl]: "gl2" },
      { entries: [entry({ ...gitlab, key: "2" })], nextCursors: { [gl]: "gl3" }, errors: [] },
      held.firstCursors,
    );
    expect(continued.errors).toEqual([]);
    expect(continued.nextCursors).toEqual({ [gh]: "gh2", [gl]: "gl3" });
    expect(continued.entries).toHaveLength(3);
    const refreshed = refreshIssueListPage(
      continued,
      { entries: [], nextCursors: {}, errors: [] },
      { source: gitlab },
    );
    expect(refreshed.entries).toEqual([github]);
    expect(refreshed.nextCursors).toEqual({ [gh]: "gh2" });
    const narrowed = refreshIssueListPage(held, {
      entries: [gitlab],
      nextCursors: { [gl]: "gl2" },
      errors: [],
      sources: [{ ...gitlab, capabilities: {} as IssueCapabilities }],
    });
    expect(narrowed.entries).toEqual([gitlab]);
    expect(narrowed.nextCursors).toEqual({ [gl]: "gl2" });
  });

  it("continues only the scopes of the chosen host", () => {
    expect(issueListCursorsOn(cursors, "GitHub.com")).toEqual({
      "github.com acme/app": "a",
      "github.com acme/other": "b",
    });
  });

  it("keeps other hosts' cursors when one host's page lands", () => {
    const held = {
      entries: [entry({ key: "1" })],
      nextCursors: cursors,
      firstCursors: cursors,
      firstKeys: new Set<string>(),
      errors: [],
    };
    const sent = issueListCursorsOn(cursors, "github.com");
    const next = continueIssueListPage(
      held,
      sent,
      {
        entries: [entry({ key: "2" })],
        nextCursors: { "github.com acme/app": "a2" },
        errors: [],
      },
      held.firstCursors,
    );
    expect(next.nextCursors).toEqual({ "linear.app ENG": "c", "github.com acme/app": "a2" });
    expect(next.entries.map((row) => row.key).toSorted()).toEqual(["1", "2"]);
  });

  it("drops a continuation whose cursor a refresh has since moved", () => {
    const held = {
      entries: [entry({ key: "1" })],
      nextCursors: { "github.com acme/app": "2" },
      firstCursors: { "github.com acme/app": "2" },
      firstKeys: new Set([issueEntryKey(entry({ key: "1" }))]),
      errors: [],
    };
    const stale = continueIssueListPage(
      held,
      { "github.com acme/app": "4" },
      {
        entries: [entry({ key: "200" })],
        nextCursors: { "github.com acme/app": "5" },
        errors: [],
      },
      held.firstCursors,
    );
    expect(stale).toBe(held);
  });

  it("drops a continuation sent before a refresh that kept the same cursor", () => {
    const at = (key: string, day: number, title = `Issue ${key}`) =>
      entry({ key, title, updatedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z` });
    const cursor = { "github.com acme/app": "2" };
    const held = {
      entries: [at("1", 9), at("2", 8)],
      nextCursors: cursor,
      firstCursors: cursor,
      firstKeys: new Set([at("1", 9), at("2", 8)].map(issueEntryKey)),
      errors: [],
    };
    const refreshed = refreshIssueListPage(held, {
      entries: [at("4", 10, "Fresh"), at("1", 9)],
      nextCursors: cursor,
      errors: [],
    });
    expect(refreshed.nextCursors).toEqual(cursor);
    const oldPage = {
      entries: [at("3", 7), at("4", 6, "Stale")],
      nextCursors: { "github.com acme/app": "3" },
      errors: [],
    };
    expect(continueIssueListPage(refreshed, cursor, oldPage, held.firstCursors)).toBe(refreshed);
    const continued = continueIssueListPage(
      refreshed,
      cursor,
      {
        entries: [at("2", 8), at("3", 7)],
        nextCursors: { "github.com acme/app": "3" },
        errors: [],
      },
      refreshed.firstCursors,
    );
    expect(continued.entries.map((row) => row.title)).toEqual([
      "Fresh",
      "Issue 1",
      "Issue 2",
      "Issue 3",
    ]);
    expect(continued.nextCursors).toEqual({ "github.com acme/app": "3" });
  });

  it("retries a failed scope that has no rows through the listing's sources", () => {
    const source = {
      projectId: "project-3" as ProjectId,
      projectTitle: "Empty",
      tracker: "github" as IssueTrackerKind,
      host: "github.com",
      scope: "acme/empty",
      capabilities: {} as IssueCapabilities,
    };
    const held = {
      entries: [] as ReadonlyArray<IssueListEntry>,
      nextCursors: { "github.com acme/empty": "e2" },
      firstCursors: { "github.com acme/empty": "e2" },
      firstKeys: new Set<string>(),
      errors: [],
      sources: [source],
    };
    const sent = { "github.com acme/empty": "e2" };
    const down = {
      projectId: source.projectId,
      projectTitle: "Empty",
      host: "github.com",
      message: "down",
    };
    const failed = continueIssueListPage(
      held,
      sent,
      { entries: [], nextCursors: {}, errors: [down] },
      held.firstCursors,
    );
    expect(failed.nextCursors).toEqual(sent);
    expect(failed.errors).toEqual([down]);
    const recovered = continueIssueListPage(
      failed,
      sent,
      {
        entries: [entry({ key: "7", scope: "acme/empty", projectId: source.projectId })],
        nextCursors: {},
        errors: [],
      },
      held.firstCursors,
    );
    expect(recovered.errors).toEqual([]);
    expect(recovered.nextCursors).toEqual({});
    expect(recovered.entries.map((row) => row.key)).toEqual(["7"]);
  });

  it("shows a continuation's errors and clears only the retried project's old ones", () => {
    const failure = (projectId: string, host: string, message: string) => ({
      projectId: projectId as ProjectId,
      projectTitle: projectId,
      host,
      message,
    });
    const held = {
      entries: [entry({ key: "1" }), entry({ key: "ENG-1", host: "linear.app", scope: "ENG" })],
      nextCursors: cursors,
      firstCursors: cursors,
      firstKeys: new Set<string>(),
      errors: [
        failure("project-1", "github.com", "old"),
        failure("project-2", "linear.app", "kept"),
      ],
    };
    const failed = continueIssueListPage(
      held,
      { "github.com acme/app": "a" },
      {
        entries: [],
        nextCursors: {},
        errors: [failure("project-1", "github.com", "rate limited")],
      },
      held.firstCursors,
    );
    expect(failed.errors.map((error) => error.message)).toEqual(["kept", "rate limited"]);
    expect(failed.nextCursors["github.com acme/app"]).toBe("a");
    const recovered = continueIssueListPage(
      failed,
      { "github.com acme/app": "a" },
      {
        entries: [entry({ key: "2" })],
        nextCursors: {},
        errors: [],
      },
      held.firstCursors,
    );
    expect(recovered.errors.map((error) => error.message)).toEqual(["kept"]);
  });
});

describe("issue representative changes", () => {
  it.each([
    { cursor: "github github.com acme/app", sources: true },
    { cursor: "github github.com acme/app", sources: false },
    { cursor: "github.com acme/app", sources: true },
    { cursor: "github.com acme/app", sources: false },
  ])("rebinds earlier rows when a continuation changes project: %j", ({ cursor, sources }) => {
    const old = entry({ key: "1", projectTitle: "Old checkout" });
    const repeated = entry({ key: "2", projectTitle: old.projectTitle });
    const other = entry({
      key: "9",
      tracker: "gitlab" as IssueTrackerKind,
      projectTitle: "Other tracker",
    });
    const replacement = entry({
      key: "2",
      projectId: "replacement" as ProjectId,
      projectTitle: "Current checkout",
      host: "GitHub.COM",
      scope: "Acme/App",
      title: "Updated issue 2",
    });
    const otherCursor = "gitlab github.com acme/app";
    const otherError = {
      projectId: other.projectId,
      projectTitle: other.projectTitle,
      tracker: other.tracker,
      host: other.host,
      message: "Other tracker is unavailable",
    };
    const held = {
      entries: [old, repeated, other],
      sources: [
        { ...old, capabilities: {} as IssueCapabilities },
        { ...other, capabilities: {} as IssueCapabilities },
      ],
      firstKeys: new Set([old, repeated, other].map(issueEntryKey)),
      firstCursors: { [cursor]: "2", [otherCursor]: "o2" },
      nextCursors: { [cursor]: "2", [otherCursor]: "o2" },
      errors: [otherError],
    };
    const page = {
      entries: [replacement, entry({ ...replacement, key: "3" })],
      ...(sources ? { sources: [{ ...replacement, capabilities: {} as IssueCapabilities }] } : {}),
      nextCursors: { [cursor]: "3" },
      errors: [],
    };
    const continued = continueIssueListPage(held, { [cursor]: "2" }, page, held.firstCursors);
    const rows = continued.entries.filter((row) => row.tracker === old.tracker);
    expect(
      rows.map((row) => [row.projectId, row.projectTitle, row.key, row.title]).toSorted(),
    ).toEqual([
      ["replacement", "Current checkout", "1", old.title],
      ["replacement", "Current checkout", "2", "Updated issue 2"],
      ["replacement", "Current checkout", "3", replacement.title],
    ]);
    expect(continued.entries.find((row) => row.tracker === other.tracker)).toEqual(other);
    expect(rows.find((row) => row.key === "1")).toMatchObject({
      host: old.host,
      scope: old.scope,
      tracker: old.tracker,
    });
    expect(
      continued.sources?.map(({ projectId, projectTitle }) => [projectId, projectTitle]),
    ).toEqual([
      ["replacement", "Current checkout"],
      [other.projectId, other.projectTitle],
    ]);
    expect(continued.firstKeys).toEqual(
      new Set([
        issueEntryKey({ ...old, projectId: replacement.projectId }),
        issueEntryKey(replacement),
        issueEntryKey(other),
      ]),
    );
    expect(continued.firstCursors).toBe(held.firstCursors);
    expect(continued.nextCursors).toEqual({ [cursor]: "3", [otherCursor]: "o2" });
    expect(continued.errors).toEqual([otherError]);
    const fresh = refreshIssueListPage(continued, {
      entries: [entry({ ...replacement, key: "1" }), replacement, other],
      nextCursors: held.firstCursors,
      errors: [otherError],
      sources: [
        { ...replacement, capabilities: {} as IssueCapabilities },
        { ...other, capabilities: {} as IssueCapabilities },
      ],
    });
    expect(fresh.entries.filter((row) => row.tracker === old.tracker)).toHaveLength(3);
    expect(fresh.nextCursors[cursor]).toBe("3");
    const next = continueIssueListPage(
      fresh,
      { [cursor]: "3" },
      {
        entries: [entry({ ...replacement, key: "3" }), entry({ ...replacement, key: "4" })],
        nextCursors: {},
        errors: [],
      },
      fresh.firstCursors,
    );
    expect(
      next.entries
        .filter((row) => row.tracker === old.tracker)
        .map((row) => row.key)
        .toSorted(),
    ).toEqual(["1", "2", "3", "4"]);
    expect(next.nextCursors).toEqual({ [otherCursor]: "o2" });
    expect(next.errors).toEqual([otherError]);
  });

  it("rebinds and deduplicates an empty successful continuation using its source metadata", () => {
    const old = entry({ key: "1" });
    const replacement = entry({
      ...old,
      projectId: "replacement" as ProjectId,
      projectTitle: "Current checkout",
    });
    const cursor = { "github github.com acme/app": "2" };
    const held = {
      entries: [old, replacement],
      sources: [{ ...old, capabilities: {} as IssueCapabilities }],
      firstKeys: new Set([issueEntryKey(old)]),
      firstCursors: cursor,
      nextCursors: cursor,
      errors: [],
    };
    const page = {
      entries: [],
      sources: [{ ...replacement, capabilities: {} as IssueCapabilities }],
      nextCursors: {},
      errors: [],
    };
    const failed = continueIssueListPage(
      held,
      cursor,
      {
        ...page,
        errors: [
          {
            projectId: replacement.projectId,
            projectTitle: replacement.projectTitle,
            tracker: replacement.tracker,
            host: replacement.host,
            message: "down",
          },
        ],
      },
      held.firstCursors,
    );
    expect(failed.entries).toEqual(held.entries);
    expect(failed.sources).toEqual(held.sources);
    expect(failed.firstKeys).toEqual(held.firstKeys);
    expect(failed.nextCursors).toEqual(cursor);
    const success = continueIssueListPage(failed, cursor, page, held.firstCursors);
    expect(success.errors).toEqual([]);
    expect(success.entries).toEqual([replacement]);
    expect(success.sources?.[0]).toMatchObject({
      projectId: replacement.projectId,
      projectTitle: replacement.projectTitle,
    });
    expect(success.firstKeys).toEqual(new Set([issueEntryKey(replacement)]));
    expect(success.nextCursors).toEqual({});
    const withoutHeldMetadata = continueIssueListPage(
      { ...held, sources: undefined },
      cursor,
      page,
      held.firstCursors,
    );
    expect(withoutHeldMetadata.entries).toEqual([replacement]);
    expect(withoutHeldMetadata.sources).toEqual(page.sources);
    const withoutMetadata = continueIssueListPage(
      held,
      cursor,
      { entries: [], nextCursors: {}, errors: [] },
      held.firstCursors,
    );
    expect(withoutMetadata.entries).toEqual(held.entries);
  });

  it("drops the old owner's tail and restarts its cursor, while keeping failed and unrelated sources", () => {
    const old = entry({ key: "1" });
    const tail = entry({ key: "2" });
    const other = entry({ key: "9", scope: "acme/other", projectId: "other" as ProjectId });
    const replacement = entry({ key: "1", projectId: "replacement" as ProjectId });
    const scope = "github github.com acme/app";
    const otherScope = "github github.com acme/other";
    const held = {
      entries: [old, tail, other],
      firstKeys: new Set([old, other].map(issueEntryKey)),
      firstCursors: { [scope]: "2", [otherScope]: "o2" },
      nextCursors: { [scope]: "3", [otherScope]: "o2" },
      errors: [],
    };
    const fresh = {
      entries: [replacement],
      sources: [
        { ...replacement, capabilities: {} as IssueCapabilities },
        { ...other, capabilities: {} as IssueCapabilities },
      ],
      nextCursors: { [scope]: "2" },
      errors: [
        {
          projectId: other.projectId,
          projectTitle: "App",
          tracker: other.tracker,
          host: other.host,
          message: "down",
        },
      ],
    };
    const refreshed = refreshIssueListPage(held, fresh);
    expect(refreshed.entries).toHaveLength(2);
    expect(refreshed.entries).toEqual(expect.arrayContaining([replacement, other]));
    expect(refreshed.nextCursors).toEqual({ [scope]: "2", [otherScope]: "o2" });
    const continued = continueIssueListPage(
      refreshed,
      { [scope]: "2" },
      { entries: [entry({ ...replacement, key: "2" })], nextCursors: {}, errors: [] },
      refreshed.firstCursors,
    );
    expect(continued.entries.map(({ projectId, key }) => [projectId, key]).toSorted()).toEqual([
      [other.projectId, "9"],
      ["replacement", "1"],
      ["replacement", "2"],
    ]);
    const failed = refreshIssueListPage(held, {
      ...fresh,
      entries: [],
      errors: [
        {
          projectId: replacement.projectId,
          projectTitle: "App",
          tracker: replacement.tracker,
          host: replacement.host,
          message: "down",
        },
        ...fresh.errors,
      ],
    });
    expect(failed.entries).toEqual(held.entries);
    expect(failed.nextCursors).toEqual(held.nextCursors);
  });
});

describe("refreshIssueListPage", () => {
  const rows = (from: number, to: number, scope = "acme/app") =>
    Array.from({ length: to - from + 1 }, (_, index) =>
      entry({
        key: `${from + index}`,
        scope,
        projectId: (scope === "acme/app" ? "project-1" : "project-2") as ProjectId,
        updatedAt: `2026-10-01T00:00:00.${String(999 - from - index).padStart(3, "0")}Z`,
      }),
    );
  const loaded = {
    entries: [...rows(1, 100), ...rows(201, 250, "acme/other")],
    nextCursors: { "github.com acme/app": "3", "github.com acme/other": "o2" },
    firstCursors: { "github.com acme/app": "2", "github.com acme/other": "o2" },
    firstKeys: new Set([...rows(1, 50), ...rows(201, 250, "acme/other")].map(issueEntryKey)),
    errors: [] as IssueListResult["errors"],
  };

  it("removes every changed tail row when source writes share one trailing refresh", () => {
    const next = refreshIssueListPage(
      loaded,
      {
        entries: rows(1, 50),
        nextCursors: { "github.com acme/app": "2" },
        errors: [],
      },
      {
        source: {
          tracker: "github",
          projectId: "project-1",
          host: "github.com",
          scope: "acme/app",
        },
        removed: new Set(["60", "61"].map((key) => issueEntryKey(entry({ key })))),
      },
    );
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(98);
    expect(next.entries.some((row) => row.key === "60" || row.key === "61")).toBe(false);
    expect(next.entries.filter((row) => row.scope === "acme/other")).toHaveLength(50);
  });

  it("keeps a continued scope's tail and cursor under a fresh first page", () => {
    const next = refreshIssueListPage(loaded, {
      entries: [...rows(1, 50), ...rows(202, 251, "acme/other")],
      nextCursors: { "github.com acme/app": "2", "github.com acme/other": "o2" },
      errors: [],
    });
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(100);
    expect(next.entries.some((row) => row.key === "201")).toBe(false);
    expect(next.entries.some((row) => row.key === "251")).toBe(true);
    expect(next.nextCursors).toEqual(loaded.nextCursors);
    expect(next.firstCursors).toEqual(loaded.firstCursors);
  });

  it.each(["github.com acme/app", "github github.com acme/app"])(
    "restores an exhausted cursor when its first-page token changes: %s",
    (scope) => {
      const first = {
        entries: rows(1, 2),
        nextCursors: { [scope]: "2" },
        firstCursors: { [scope]: "2" },
        firstKeys: new Set(rows(1, 2).map(issueEntryKey)),
        errors: [],
      };
      const completed = continueIssueListPage(
        first,
        first.nextCursors,
        {
          entries: rows(3, 4),
          nextCursors: {},
          errors: [],
        },
        first.firstCursors,
      );
      expect(completed.entries).toEqual(rows(1, 4));
      expect(completed.nextCursors).toEqual({});
      const fresh = refreshIssueListPage(completed, {
        entries: rows(1, 2),
        nextCursors: { [scope]: "fresh-2" },
        errors: [],
      });
      expect(fresh.entries).toEqual(rows(1, 4));
      expect(fresh.nextCursors).toEqual({ [scope]: "fresh-2" });
      expect(fresh.firstKeys).toEqual(first.firstKeys);
      const failed = refreshIssueListPage(fresh, {
        entries: [],
        nextCursors: {},
        errors: [{ projectId: "project-1" as ProjectId, projectTitle: "App", message: "down" }],
      });
      expect(failed.entries).toEqual(fresh.entries);
      expect(failed.nextCursors).toEqual(fresh.nextCursors);
      const next = continueIssueListPage(
        failed,
        { [scope]: "fresh-2" },
        {
          entries: rows(3, 5),
          nextCursors: {},
          errors: [],
        },
        failed.firstCursors,
      );
      expect(next.entries).toEqual(rows(1, 5));
      expect(next.nextCursors).toEqual({});
      expect(next.errors).toEqual([]);
      const terminal = refreshIssueListPage(completed, {
        entries: rows(1, 2),
        nextCursors: {},
        errors: [],
      });
      expect(terminal.entries).toEqual(rows(1, 2));
      expect(terminal.nextCursors).toEqual({});
    },
  );

  it.each([40, 50])(
    "drops a continued scope's tail when a fresh first page of %i rows ends the listing",
    (count) => {
      const next = refreshIssueListPage(loaded, {
        entries: [...rows(1, count), ...rows(201, 250, "acme/other")],
        nextCursors: { "github.com acme/other": "o2" },
        errors: [],
      });
      expect(next.entries.filter((row) => row.scope === "acme/app")).toEqual(rows(1, count));
      expect(next.nextCursors).toEqual({ "github.com acme/other": "o2" });
      expect(next.firstCursors).toEqual({ "github.com acme/other": "o2" });
    },
  );

  it("replaces the old first page and keeps the loaded tail", () => {
    const [one, two, three] = rows(1, 3);
    const held = {
      entries: [one!, two!, three!],
      nextCursors: { "github.com acme/app": "3" },
      firstCursors: { "github.com acme/app": "2" },
      firstKeys: new Set([one!, two!].map(issueEntryKey)),
      errors: [],
    };
    const next = refreshIssueListPage(held, {
      entries: [{ ...two!, title: "Renamed" }, entry({ key: "4" })],
      nextCursors: { "github.com acme/app": "2" },
      errors: [],
    });
    expect(next.entries.map((row) => [row.key, row.title]).toSorted()).toEqual([
      ["2", "Renamed"],
      ["3", "Issue 3"],
      ["4", "Issue 4"],
    ]);
    expect(next.nextCursors).toEqual({ "github.com acme/app": "2" });
    expect(next.firstKeys).toEqual(new Set(["2", "4"].map((key) => issueEntryKey(entry({ key })))));
  });

  it("reopens a finished scope when a new row shifts its first page", () => {
    const [one, two, three] = rows(1, 3);
    const zero = entry({ key: "0", updatedAt: "2026-10-02T00:00:00.000Z" });
    const held = {
      entries: [one!, two!, three!],
      nextCursors: {},
      firstCursors: { "github.com acme/app": "2" },
      firstKeys: new Set([one!, two!].map(issueEntryKey)),
      errors: [],
    };
    const refreshed = refreshIssueListPage(held, {
      entries: [zero, one!],
      nextCursors: { "github.com acme/app": "2" },
      errors: [],
    });
    expect(refreshed.entries.map((row) => row.key)).toEqual(["0", "1", "3"]);
    expect(issueListCursorsOn(refreshed.nextCursors, "github.com")).toEqual({
      "github.com acme/app": "2",
    });
    const continued = continueIssueListPage(
      refreshed,
      refreshed.nextCursors,
      { entries: [two!, three!], nextCursors: {}, errors: [] },
      refreshed.firstCursors,
    );
    expect(continued.entries.map((row) => row.key)).toEqual(["0", "1", "2", "3"]);
  });

  it("takes a finished first page's end when nothing was continued", () => {
    const next = refreshIssueListPage(
      {
        entries: rows(1, 50),
        nextCursors: {},
        firstCursors: {},
        firstKeys: new Set(rows(1, 50).map(issueEntryKey)),
        errors: [],
      },
      { entries: rows(1, 50), nextCursors: { "github.com acme/app": "2" }, errors: [] },
    );
    expect(next.nextCursors).toEqual({ "github.com acme/app": "2" });
    expect(next.firstCursors).toEqual({ "github.com acme/app": "2" });
  });

  it("drops a mutated row the fresh page of its source no longer lists", () => {
    const next = refreshIssueListPage(
      loaded,
      { entries: rows(2, 51), nextCursors: { "github.com acme/app": "2" }, errors: [] },
      {
        source: {
          tracker: "github",
          projectId: "project-1",
          host: "GitHub.com",
          scope: "Acme/App",
        },
        removed: issueEntryKey(entry({ key: "1" })),
      },
    );
    expect(next.entries.some((row) => row.key === "1")).toBe(false);
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(99);
    expect(next.entries.filter((row) => row.scope === "acme/other")).toHaveLength(50);
    expect(next.nextCursors).toEqual({ "github.com acme/app": "2", "github.com acme/other": "o2" });
  });

  it("keeps a failed source's rows and cursors and shows its fresh error", () => {
    const next = refreshIssueListPage(
      loaded,
      {
        entries: rows(202, 251, "acme/other"),
        nextCursors: { "github.com acme/other": "o2" },
        errors: [
          {
            projectId: "project-1" as ProjectId,
            projectTitle: "App",
            host: "github.com",
            message: "down",
          },
        ],
      },
      { removed: issueEntryKey(entry({ key: "1" })) },
    );
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(100);
    expect(next.nextCursors).toEqual(loaded.nextCursors);
    expect(next.entries.some((row) => row.key === "251")).toBe(true);
    expect(next.errors.map((error) => error.message)).toEqual(["down"]);
  });

  it("forgets a scope the fresh listing no longer binds", () => {
    const next = refreshIssueListPage(
      { ...loaded, sources: [] },
      {
        entries: rows(1, 50),
        nextCursors: { "github.com acme/app": "2" },
        errors: [],
        sources: [
          {
            projectId: "project-1" as ProjectId,
            projectTitle: "App",
            tracker: "github" as IssueTrackerKind,
            host: "github.com",
            scope: "acme/app",
            capabilities: {} as IssueCapabilities,
          },
        ],
      },
    );
    expect(next.entries.some((row) => row.scope === "acme/other")).toBe(false);
    expect(next.entries.filter((row) => row.scope === "acme/app")).toHaveLength(100);
    expect(next.nextCursors).toEqual({ "github.com acme/app": "3" });
    expect(next.firstCursors).toEqual({ "github.com acme/app": "2" });
  });

  it("refreshes only the named source's rows and cursors", () => {
    const held = {
      entries: [...rows(1, 50), ...rows(201, 250, "acme/other")],
      nextCursors: { "github.com acme/app": "2", "github.com acme/other": "o2" },
      firstCursors: { "github.com acme/app": "2", "github.com acme/other": "o2" },
      firstKeys: new Set([...rows(1, 50), ...rows(201, 250, "acme/other")].map(issueEntryKey)),
      errors: [],
    };
    const next = refreshIssueListPage(
      held,
      { entries: [entry({ key: "1", title: "Retitled" })], nextCursors: {}, errors: [] },
      {
        source: {
          tracker: "github",
          projectId: "project-1",
          host: "github.com",
          scope: "acme/app",
        },
      },
    );
    expect(next.entries.filter((row) => row.scope === "acme/app").map((row) => row.title)).toEqual([
      "Retitled",
    ]);
    expect(next.entries.filter((row) => row.scope === "acme/other")).toHaveLength(50);
    expect(next.nextCursors).toEqual({ "github.com acme/other": "o2" });
  });
});

describe("issueScopeKey", () => {
  it("matches one scope by case, and keeps other environments and trackers apart", () => {
    const scope = { tracker: "github", host: "github.com", scope: "acme/app" };
    const environment = "env-1" as EnvironmentId;
    expect(issueScopeKey(environment, { ...scope, host: "GitHub.com", scope: "Acme/App" })).toBe(
      issueScopeKey(environment, scope),
    );
    expect(issueScopeKey("env-2" as EnvironmentId, scope)).not.toBe(
      issueScopeKey(environment, scope),
    );
    expect(issueScopeKey(environment, { ...scope, tracker: "jira" })).not.toBe(
      issueScopeKey(environment, scope),
    );
  });
});

describe("offeredIssueInvolvements", () => {
  const capabilities = (involvements?: IssueCapabilities["involvements"]) =>
    ({ involvements }) as IssueCapabilities;

  it("offers every choice while any readable tracker has not narrowed them", () => {
    expect(
      offeredIssueInvolvements(
        [{ capabilities: capabilities(["all", "assigned"]) }, { capabilities: capabilities() }],
        "all",
      ),
    ).toBeNull();
  });

  it("offers the union of declared choices and keeps the active one", () => {
    expect(
      offeredIssueInvolvements(
        [{ capabilities: capabilities(["all", "assigned", "authored"]) }, { capabilities: null }],
        "mentioned",
      ),
    ).toEqual(new Set(["mentioned", "all", "assigned", "authored"]));
  });
});

it("resolves one clicked issue URL in the requested environment and preferred project", async () => {
  const input = {
    url: "https://linear.app/workspace/issue/ENG-42/name",
    projectId: "project-1" as ProjectId,
  };
  const reference = {
    projectId: input.projectId,
    tracker: "linear" as IssueTrackerKind,
    host: "linear.app",
    scope: "workspace/ENG",
    key: "ENG-42",
    writable: true,
  };
  const session: AuthSessionState = {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationReadScope],
    permissions: [AuthOrchestrationReadScope],
  };
  const sessionAtom = Atom.make(AsyncResult.success(session));
  const sessions = vi
    .spyOn(Session, "createEnvironmentSessionAtoms")
    .mockReturnValue({ sessionStateAtom: () => sessionAtom } as unknown as ReturnType<
      typeof Session.createEnvironmentSessionAtoms
    >);
  const request = vi.spyOn(RpcClient, "requestGuarded");
  request.mockImplementation((() => Effect.succeed(reference)) as unknown as Parameters<
    typeof request.mockImplementation
  >[0]);
  const run = vi.fn((_environmentId: EnvironmentId, effect: Effect.Effect<unknown>) => effect);
  const runtime = Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
  const atoms = createIssueEnvironmentAtoms(runtime);
  const registry = AtomRegistry.make();
  const environmentId = "environment-1" as EnvironmentId;
  try {
    const result = await atoms.resolveUrl.run(registry, { environmentId, input });
    expect(result).toMatchObject({ _tag: "Success", value: reference });
    expect(request).toHaveBeenCalledExactlyOnceWith("issues.resolveUrl", input);
    expect(run.mock.calls[0]?.[0]).toBe(environmentId);
  } finally {
    registry.dispose();
    request.mockRestore();
    sessions.mockRestore();
  }
});
