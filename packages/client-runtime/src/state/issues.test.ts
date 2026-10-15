import type {
  AuthSessionState,
  EnvironmentId,
  IssueCapabilities,
  IssueComment,
  IssueCommentsPageInput,
  IssueListEntry,
  IssueListInput,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";
import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  IssueListResult,
  issueListCursorKey,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcClient from "../rpc/client.ts";
import * as Session from "./session.ts";
import { executeAtomQuery } from "./runtime.ts";

import {
  continueIssueListPage,
  createIssueEnvironmentAtoms,
  createIssueSourceRefreshQueue,
  readIssueListSourcePage,
  issueEntryKey,
  issueListCursorsOn,
  issueScopeKey,
  mergeIssueListPage,
  offeredIssueInvolvements,
  prependIssueComments,
  refreshIssueListPage,
} from "./issues.ts";

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
  const session = Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope],
      permissions: [AuthOrchestrationReadScope],
    } satisfies AuthSessionState),
  );
  const sessions = Session.createEnvironmentSessionAtoms(runtime);
  const sessionFactory = vi.spyOn(Session, "createEnvironmentSessionAtoms").mockReturnValue({
    ...sessions,
    sessionStateAtom: () => session,
  });
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
    sessionFactory.mockRestore();
  }
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

  it.each(["gitlab gitlab.example group/app", "gitlab.example group/app"])(
    "keeps a completed 75-row scope terminal after an unchanged first refresh: %s",
    async (cursor) => {
      const { atoms, registry, dispose } = issueReadHarness();
      const nativeRows = (from: number, to: number) =>
        rows(from, to).map((row) => ({
          ...row,
          tracker: "gitlab" as IssueTrackerKind,
          host: "gitlab.example",
          scope: "group/app",
        }));
      const initial: IssueListResult = {
        entries: nativeRows(1, 50),
        nextCursors: { [cursor]: "2" },
        viewers: { "gitlab gitlab.example": "A" },
        trackers: [],
        errors: [],
      };
      const last = { ...initial, entries: nativeRows(51, 75), nextCursors: {} };
      const replies = [initial, last, initial];
      const request = vi.spyOn(RpcClient, "requestGuarded");
      request.mockImplementation((() => Effect.succeed(replies.shift()!)) as unknown as Parameters<
        typeof request.mockImplementation
      >[0]);
      const read = async (input: IssueListInput) => {
        const result = await atoms.listPage.run(registry, {
          environmentId: "environment" as EnvironmentId,
          input,
        });
        if (result._tag !== "Success") throw new Error("list read failed");
        return result.value;
      };
      try {
        const input = { state: "all" as const, involvement: "assigned" as const, limit: 50 };
        const answer = await read(input);
        const first = {
          answer,
          entries: answer.entries,
          nextCursors: answer.nextCursors,
          firstCursors: answer.nextCursors,
          firstKeys: new Set(answer.entries.map(issueEntryKey)),
          errors: answer.errors,
        };
        const completed = continueIssueListPage(
          first,
          first.nextCursors,
          await read({ ...input, cursors: first.nextCursors }),
          first.firstCursors,
        );
        expect(completed.entries).toHaveLength(75);
        expect(completed.nextCursors).toEqual({});
        const refreshed = refreshIssueListPage(completed, await read(input));
        expect(refreshed.entries).toEqual(nativeRows(1, 75));
        expect(refreshed.nextCursors).toEqual({});
        expect(refreshed.firstCursors).toEqual(first.firstCursors);
        expect(refreshed.firstKeys).toEqual(first.firstKeys);
        expect(refreshIssueListPage(refreshed, initial).nextCursors).toEqual({});
        expect(request.mock.calls.map(([, payload]) => payload)).toEqual([
          input,
          { ...input, cursors: first.nextCursors },
          input,
        ]);
        expect(replies).toEqual([]);
      } finally {
        dispose();
        request.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "keeps completed native mounts separate through a scoped case-alias refresh, legacy: %s",
    (legacy) => {
      const upper = entry({
        key: "42",
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Root/Mount/ACME/Web",
      });
      const lower = entry({
        ...upper,
        scope: "Root/mount/acme/web",
        projectId: "lower" as ProjectId,
      });
      const current = { ...upper, scope: "Root/Mount/acme/web" };
      const cursorFor = (row: IssueListEntry) =>
        legacy ? `${row.host} ${row.scope}` : issueListCursorKey(row);
      const upperCursor = cursorFor(upper),
        lowerCursor = cursorFor(lower),
        freshCursor = cursorFor(current);
      const source = (row: IssueListEntry) => ({ ...row, capabilities: {} as IssueCapabilities });
      const initial = {
        entries: [upper, lower],
        sources: [source(upper), source(lower)],
        nextCursors: { [upperCursor]: "2", [lowerCursor]: "other-2" },
        viewers: { [issueListCursorKey(upper)]: "A", [issueListCursorKey(lower)]: "A" },
        errors: [],
      };
      const first = {
        ...initial,
        firstCursors: initial.nextCursors,
        firstKeys: new Set(initial.entries.map(issueEntryKey)),
      };
      const tail = entry({ ...upper, key: "tail" });
      const completed = continueIssueListPage(
        first,
        { [upperCursor]: "2" },
        { ...initial, entries: [tail], nextCursors: {} },
        first.firstCursors,
      );
      const fresh = {
        ...initial,
        entries: [current],
        sources: [source(current)],
        nextCursors: { [freshCursor]: "2" },
      };
      const refreshed = refreshIssueListPage(completed, fresh, { source: current });
      expect(refreshed.entries).toEqual([lower, tail, current]);
      expect(refreshed.nextCursors).toEqual({ [lowerCursor]: "other-2" });
      expect(refreshed.firstCursors).toEqual({ [lowerCursor]: "other-2", [freshCursor]: "2" });
      expect(refreshed.firstKeys).toEqual(new Set([issueEntryKey(lower), issueEntryKey(current)]));
      const failed = refreshIssueListPage(
        refreshed,
        {
          ...fresh,
          entries: [],
          nextCursors: {},
          errors: [
            {
              projectId: upper.projectId,
              projectTitle: upper.projectTitle,
              tracker: upper.tracker,
              host: upper.host,
              message: "down",
            },
          ],
        },
        { source: current },
      );
      expect(failed.entries).toEqual(refreshed.entries);
      expect(failed.nextCursors).toEqual(refreshed.nextCursors);
      const switched = refreshIssueListPage(
        refreshed,
        { ...fresh, viewers: { [issueListCursorKey(current)]: "B" } },
        { source: current },
      );
      expect(switched.entries).toEqual([lower, current]);
      expect(switched.nextCursors).toEqual({ [lowerCursor]: "other-2", [freshCursor]: "2" });
      const rebound = { ...current, projectId: "replacement" as ProjectId };
      const replaced = refreshIssueListPage(
        refreshed,
        { ...fresh, entries: [rebound], sources: [source(rebound)] },
        { source: rebound },
      );
      expect(replaced.entries).toEqual([lower, rebound]);
      expect(replaced.nextCursors).toEqual({ [lowerCursor]: "other-2", [freshCursor]: "2" });
      const terminal = refreshIssueListPage(
        refreshed,
        { ...fresh, nextCursors: {} },
        { source: current },
      );
      expect(terminal.entries).toEqual([lower, current]);
      expect(terminal.nextCursors).toEqual({ [lowerCursor]: "other-2" });
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

describe("prependIssueComments", () => {
  const comment = (id: string): IssueComment => ({
    id,
    author: null,
    body: id,
    createdAt: "2026-10-01T00:00:00.000Z",
    url: null,
  });

  it("puts older comments first and drops ones already shown", () => {
    const current = [comment("c3"), comment("c4")];
    const older = [comment("c1"), comment("c2"), comment("c3")];
    expect(prependIssueComments(current, older).map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

describe("held issue list viewers", () => {
  const row = (key: string, overrides: Partial<IssueListEntry> = {}) =>
    entry({ ...overrides, key });
  const source = (entry: IssueListEntry) => ({ ...entry, capabilities: {} as IssueCapabilities });
  const cursor = "github github.com acme/app";
  const answer = (
    entries: IssueListResult["entries"],
    nextCursors: IssueListResult["nextCursors"],
    viewer: string | null = "A",
  ): IssueListResult => ({
    entries,
    nextCursors,
    viewers: viewer === null ? {} : { "github github.com": viewer },
    sources: [source(row("source"))],
    trackers: [],
    errors: [],
  });
  const first = (page = answer([row("first")], { [cursor]: "A2" })) => ({
    answer: page,
    entries: page.entries,
    sources: page.sources,
    errors: page.errors,
    nextCursors: page.nextCursors,
    firstCursors: page.nextCursors,
    firstKeys: new Set(page.entries.map(issueEntryKey)),
  });
  const loaded = (key = cursor) => {
    const held = first(answer([row("first")], { [key]: "A2" }));
    return continueIssueListPage(
      held,
      held.nextCursors,
      answer([row("A-tail")], { [key]: "A3" }),
      held.firstCursors,
    );
  };
  const keys = (page: { entries: IssueListResult["entries"] }) =>
    page.entries.map((entry) => entry.key);

  const decodeIssueList = Schema.decodeUnknownSync(IssueListResult);

  it.each(["refresh", "continue"])(
    "retains a failed mount account until its successful %s recovery",
    (operation) => {
      const upper = row("upper-first", {
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Mount/acme/web",
        projectId: "upper" as ProjectId,
      });
      const lower = row("lower-first", {
        ...upper,
        scope: "mount/acme/web",
        projectId: "lower" as ProjectId,
      });
      const upperCursor = issueListCursorKey(upper),
        lowerCursor = issueListCursorKey(lower);
      const initial = {
        ...answer([upper, lower], { [upperCursor]: "2", [lowerCursor]: "2" }),
        sources: [source(upper), source(lower)],
        viewers: { [upperCursor]: "alice", [lowerCursor]: "bob" },
      };
      const held = first(initial);
      const tailed = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("upper-tail", upper), row("lower-tail", lower)],
          nextCursors: { [upperCursor]: "3", [lowerCursor]: "3" },
        },
        held.firstCursors,
      );
      const failed = {
        ...initial,
        entries: operation === "refresh" ? [upper] : [],
        viewers: { [upperCursor]: "alice", [lowerCursor]: "charlie" },
        nextCursors: operation === "refresh" ? { [upperCursor]: "2" } : {},
        errors: [
          {
            projectId: lower.projectId,
            projectTitle: lower.projectTitle,
            tracker: lower.tracker,
            host: lower.host,
            message: "unavailable",
          },
        ],
      };
      const next =
        operation === "refresh"
          ? refreshIssueListPage(tailed, failed)
          : continueIssueListPage(tailed, { [lowerCursor]: "3" }, failed, tailed.firstCursors);
      expect(keys(next).toSorted()).toEqual([
        "lower-first",
        "lower-tail",
        "upper-first",
        "upper-tail",
      ]);
      expect(next.nextCursors).toEqual(tailed.nextCursors);
      const recovered = refreshIssueListPage(
        next,
        {
          ...initial,
          entries: [lower],
          sources: [source(lower)],
          viewers: { [lowerCursor]: "charlie" },
          nextCursors: { [lowerCursor]: "2" },
        },
        { source: lower },
      );
      expect(keys(recovered).toSorted()).toEqual(["lower-first", "upper-first", "upper-tail"]);
      expect(recovered.nextCursors).toEqual({ [upperCursor]: "3", [lowerCursor]: "2" });
      expect(recovered.errors).toEqual([]);
    },
  );

  it.each(["qualified", "legacy", "missing"])(
    "keeps known mount viewers when a %s host frame is ambiguous",
    (kind) => {
      const upper = row("upper-first", {
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Mount/acme/web",
      });
      const lower = row("lower-first", { ...upper, scope: "mount/acme/web" });
      const upperCursor = issueListCursorKey(upper);
      const lowerCursor = issueListCursorKey(lower);
      const initial = {
        ...answer([upper, lower], { [upperCursor]: "2", [lowerCursor]: "2" }),
        sources: [source(upper), source(lower)],
        viewers: { [upperCursor]: "alice", [lowerCursor]: "bob" },
      };
      const held = first(initial);
      const tailed = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("upper-tail", upper), row("lower-tail", lower)],
          nextCursors: { [upperCursor]: "3", [lowerCursor]: "3" },
        },
        held.firstCursors,
      );
      const viewers: Record<string, string> =
        kind === "qualified"
          ? { "forgejo forge.example": "legacy" }
          : kind === "legacy"
            ? { "forge.example": "legacy" }
            : {};
      const unknown = refreshIssueListPage(tailed, { ...initial, viewers });
      expect(keys(unknown).toSorted()).toEqual([
        "lower-first",
        "lower-tail",
        "upper-first",
        "upper-tail",
      ]);
      expect(unknown.nextCursors).toEqual(tailed.nextCursors);
      const changed = refreshIssueListPage(
        unknown,
        {
          ...initial,
          sources: [source(lower)],
          entries: [lower],
          nextCursors: { [lowerCursor]: "2" },
          viewers: { [lowerCursor]: "charlie", "forgejo forge.example": "charlie" },
        },
        { source: lower },
      );
      expect(keys(changed).toSorted()).toEqual(["lower-first", "upper-first", "upper-tail"]);
      expect(changed.nextCursors).toEqual({ [upperCursor]: "3", [lowerCursor]: "2" });
    },
  );

  it.each(["forgejo forge.example", "forge.example"])(
    "accepts old %s viewers for several repositories in one exact native mount",
    (viewerKey) => {
      const upper = row("upper-first", {
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Mount/acme/web",
      });
      const lower = row("lower-first", { ...upper, scope: "Mount/other/api" });
      const upperCursor = issueListCursorKey(upper);
      const lowerCursor = issueListCursorKey(lower);
      const initial = {
        ...answer([upper, lower], { [upperCursor]: "2", [lowerCursor]: "2" }),
        sources: [source(upper), source(lower)],
        viewers: { [viewerKey]: "alice" },
      };
      const held = first(initial);
      const tailed = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("upper-tail", upper), row("lower-tail", lower)],
          nextCursors: { [upperCursor]: "3", [lowerCursor]: "3" },
        },
        held.firstCursors,
      );
      const changed = refreshIssueListPage(
        tailed,
        {
          ...initial,
          entries: [lower],
          sources: [source(lower)],
          nextCursors: { [lowerCursor]: "2" },
          viewers: { [viewerKey]: "bob" },
        },
        { source: lower },
      );
      expect(keys(changed).toSorted()).toEqual(["lower-first", "upper-first", "upper-tail"]);
      expect(changed.nextCursors).toEqual({ [upperCursor]: "3", [lowerCursor]: "2" });
    },
  );

  it.each(["bob", "charlie"])(
    "uses scoped native viewers through the actual list query and continuation: %s",
    async (viewer) => {
      const runtime = Atom.runtime(
        Layer.effect(
          EnvironmentRegistry.EnvironmentRegistry,
          Effect.gen(function* () {
            const state = yield* SubscriptionRef.make({ phase: "connected" } as const);
            const session = yield* SubscriptionRef.make(Option.some({}));
            const supervisor = {
              state,
              session,
            } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
            return EnvironmentRegistry.EnvironmentRegistry.of({
              run: (_id, effect) =>
                Effect.provideService(
                  effect,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisor,
                ),
              followStream: (_id, stream) =>
                Stream.provideService(
                  stream,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisor,
                ),
            } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
          }),
        ),
      );
      const registry = AtomRegistry.make();
      const atoms = createIssueEnvironmentAtoms(runtime);
      const capabilities: IssueCapabilities = {
        create: false,
        edit: false,
        comment: false,
        labels: false,
        assignees: false,
        reactions: false,
        templates: false,
        linkedPullRequests: false,
        events: false,
        search: true,
        states: [],
        closeReasons: [],
      };
      const nativeSource = (entry: IssueListEntry) => ({
        projectId: entry.projectId,
        projectTitle: entry.projectTitle,
        tracker: entry.tracker,
        host: entry.host,
        scope: entry.scope,
        capabilities,
      });
      const upper = row("upper-first", {
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Mount/acme/web",
      });
      const lower = row("lower-first", { ...upper, scope: "mount/acme/web" });
      const upperCursor = issueListCursorKey(upper);
      const lowerCursor = issueListCursorKey(lower);
      const initial = {
        ...answer([upper, lower], { [upperCursor]: "2", [lowerCursor]: "2" }),
        sources: [nativeSource(upper), nativeSource(lower)],
        viewers: { [upperCursor]: "alice", [lowerCursor]: "bob" },
      };
      const pageTwo = {
        ...initial,
        entries: [],
        sources: [nativeSource(lower)],
        viewers: { [lowerCursor]: viewer, "forgejo forge.example": viewer },
        nextCursors: {},
      };
      const replies = [
        initial,
        {
          ...initial,
          entries: [row("upper-tail", upper), row("lower-tail", lower)],
          nextCursors: { [upperCursor]: "3", [lowerCursor]: "3" },
        },
        pageTwo,
        ...(viewer === "charlie" ? [{ ...pageTwo, entries: [row("charlie-first", lower)] }] : []),
      ];
      const reads: Array<{ tag: string; input: unknown }> = [];
      const request = vi.spyOn(RpcClient, "request");
      const respond = ((tag: string, input: unknown) =>
        Effect.sync(() => {
          reads.push({ tag, input });
          const reply = replies.shift();
          if (reply === undefined) throw new Error("Unexpected native list read");
          return decodeIssueList(reply);
        })) as unknown as Parameters<typeof request.mockImplementation>[0];
      request.mockImplementation(respond);
      const guarded = vi.spyOn(RpcClient, "requestGuarded");
      guarded.mockImplementation(
        respond as unknown as Parameters<typeof guarded.mockImplementation>[0],
      );
      const input = { state: "open" as const, involvement: "assigned" as const, limit: 50 };
      const environmentId = "environment" as EnvironmentId;
      const read = async (input: IssueListInput) => {
        const result = await atoms.listPage.run(registry, { environmentId, input });
        if (result._tag !== "Success") throw new Error("Native page read failed");
        return result.value;
      };
      try {
        const firstRead = await executeAtomQuery(registry, atoms.list({ environmentId, input }), {
          reportFailure: false,
        });
        if (firstRead._tag !== "Success") throw new Error("Native first query failed");
        const held = first(firstRead.value);
        const tailed = continueIssueListPage(
          held,
          held.nextCursors,
          await read({ ...input, cursors: held.nextCursors }),
          held.firstCursors,
        );
        const next = continueIssueListPage(
          tailed,
          { [lowerCursor]: "3" },
          await read({ ...input, cursors: { [lowerCursor]: "3" } }),
          tailed.firstCursors,
        );
        expect(next.restartSources).toEqual(viewer === "charlie" ? [nativeSource(lower)] : []);
        let completed = next;
        for (const restart of next.restartSources ?? [])
          completed = refreshIssueListPage(
            completed,
            await read({ ...input, projectId: restart.projectId, host: restart.host }),
            { source: lower },
          );
        expect(keys(completed).toSorted()).toEqual(
          viewer === "charlie"
            ? ["charlie-first", "upper-first", "upper-tail"]
            : ["lower-first", "lower-tail", "upper-first", "upper-tail"],
        );
        expect(completed.nextCursors).toEqual({ [upperCursor]: "3" });
        expect(reads.map(({ tag }) => tag)).toEqual(
          Array(viewer === "charlie" ? 4 : 3).fill("issues.list"),
        );
        expect(reads[0]!.input).toEqual(input);
        expect(reads[2]!.input).toEqual({ ...input, cursors: { [lowerCursor]: "3" } });
        if (viewer === "charlie")
          expect(reads[3]!.input).toEqual({
            ...input,
            projectId: lower.projectId,
            host: lower.host,
          });
        expect(replies).toEqual([]);
      } finally {
        registry.dispose();
        request.mockRestore();
        guarded.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "removes a native mount's old first cursor after alias migration, legacy first: %s",
    (legacy) => {
      const upper = row("42", {
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Mount/acme/web",
      });
      const lower = row("42", { ...upper, scope: "mount/acme/web" });
      const qualified = issueListCursorKey(lower);
      const old = legacy ? `${lower.host} ${lower.scope}` : qualified;
      const next = legacy ? qualified : `${lower.host} ${lower.scope}`;
      const other = issueListCursorKey(upper);
      const page = {
        ...answer([upper, lower], { [old]: "2", [other]: "upper-2" }),
        sources: [source(upper), source(lower)],
        viewers: { [issueListCursorKey(upper)]: "A", [issueListCursorKey(lower)]: "A" },
      };
      const initial = first(page);
      const held = continueIssueListPage(
        initial,
        { [old]: "2" },
        { ...page, entries: [row("43", lower)], nextCursors: { [next]: "3" } },
        initial.firstCursors,
      );
      const switched = continueIssueListPage(
        held,
        { [next]: "3" },
        { ...page, entries: [], nextCursors: {}, viewers: { [issueListCursorKey(lower)]: "B" } },
        held.firstCursors,
      );
      expect(switched.entries).toEqual([upper]);
      expect(switched.firstCursors).toEqual({ [other]: "upper-2" });
      expect(switched.nextCursors).toEqual({ [other]: "upper-2" });
      expect(switched.restartSources).toEqual([source(lower)]);
    },
  );

  it("keeps a plugin's folded scope and qualified viewer on the native host", () => {
    const native = row("42", {
      tracker: "forgejo" as IssueTrackerKind,
      host: "forge.example",
      scope: "Mount/acme/web",
    });
    const plugin = row("42", {
      ...native,
      tracker: "custom" as IssueTrackerKind,
      scope: "MOUNT/ACME/WEB",
    });
    const nativeCursor = `${native.host} ${native.scope}`;
    const pluginCursor = issueListCursorKey(plugin);
    const page = {
      ...answer([native, plugin], { [nativeCursor]: "2", [pluginCursor]: "plugin-2" }),
      sources: [source(native), source(plugin)],
      viewers: { "forgejo forge.example": "A", "custom forge.example": "plugin" },
    };
    const held = first(page);
    const switched = continueIssueListPage(
      held,
      { [nativeCursor]: "2" },
      {
        ...page,
        entries: [],
        sources: [source(native)],
        nextCursors: {},
        viewers: { "forgejo forge.example": "B", "forge.example": "ambiguous" },
      },
      held.firstCursors,
    );
    expect(switched.entries).toEqual([plugin]);
    expect(switched.nextCursors).toEqual({ [pluginCursor]: "plugin-2" });
    expect(switched.restartSources).toEqual([source(native)]);
    const continued = continueIssueListPage(
      switched,
      { [pluginCursor]: "plugin-2" },
      {
        ...page,
        entries: [row("43", { ...plugin, scope: plugin.scope.toLowerCase() })],
        sources: [source(plugin)],
        nextCursors: {},
        viewers: { "custom forge.example": "plugin" },
      },
      switched.firstCursors,
    );
    expect(keys(continued)).toEqual(["42", "43"]);
    expect(continued.restartSources).toEqual([]);
  });

  it.each([false, true])(
    "keeps native mount scopes apart through refresh, viewer restart and retry, legacy: %s",
    (legacy) => {
      const upper = row("42", {
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Root/Mount/acme/web",
        projectId: "upper" as ProjectId,
      });
      const lower = row("42", {
        ...upper,
        scope: "Root/mount/Acme/Web",
        projectId: "lower" as ProjectId,
      });
      const cursorFor = (entry: IssueListEntry) =>
        legacy ? `${entry.host} ${entry.scope}` : issueListCursorKey(entry);
      const upperCursor = cursorFor(upper);
      const lowerCursor = cursorFor(lower);
      const initial = {
        ...answer([upper, lower], { [upperCursor]: "2", [lowerCursor]: "2" }),
        sources: [source(upper), source(lower)],
        viewers: { [issueListCursorKey(upper)]: "A", [issueListCursorKey(lower)]: "A" },
      };
      expect(issueEntryKey(upper)).not.toBe(
        issueEntryKey({ ...lower, projectId: upper.projectId }),
      );
      const held = first(initial);
      const tailed = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("43", upper), row("43", lower)],
          nextCursors: { [upperCursor]: "3", [lowerCursor]: "3" },
        },
        held.firstCursors,
      );
      const fresh = refreshIssueListPage(
        tailed,
        {
          ...initial,
          entries: [row("44", lower)],
          nextCursors: { [lowerCursor]: "2" },
          sources: [source(lower)],
        },
        { source: lower },
      );
      expect(fresh.entries.map((entry) => [entry.scope, entry.key])).toEqual(
        expect.arrayContaining([
          [upper.scope, "42"],
          [upper.scope, "43"],
          [lower.scope, "44"],
        ]),
      );
      expect(fresh.nextCursors).toEqual({ [upperCursor]: "3", [lowerCursor]: "2" });
      expect(issueScopeKey("environment" as EnvironmentId, upper)).not.toBe(
        issueScopeKey("environment" as EnvironmentId, lower),
      );
      const current = { ...lower, projectId: "current" as ProjectId, projectTitle: "Current" };
      const pageTwo = {
        ...initial,
        entries: [],
        sources: [source(current)],
        viewers: { [issueListCursorKey(current)]: "B" },
        nextCursors: {},
      };
      const switched = continueIssueListPage(
        tailed,
        { [lowerCursor]: "3" },
        pageTwo,
        tailed.firstCursors,
      );
      expect(switched.entries).toEqual([upper, row("43", upper)]);
      expect(switched.nextCursors).toEqual({ [upperCursor]: "3" });
      expect(switched.restartSources).toEqual([source(current)]);
      expect(switched.sources).toEqual([source(upper), source(current)]);
      const completed = refreshIssueListPage(
        switched,
        { ...pageTwo, entries: [row("9001", current)] },
        { source: current },
      );
      expect(completed.entries.map((entry) => [entry.scope, entry.key])).toEqual([
        [upper.scope, "42"],
        [upper.scope, "43"],
        [lower.scope, "9001"],
      ]);
      const failed = {
        projectId: upper.projectId,
        projectTitle: upper.projectTitle,
        tracker: upper.tracker,
        host: upper.host,
        message: "Native scope unavailable",
      };
      const unavailable = continueIssueListPage(
        completed,
        { [upperCursor]: "3" },
        {
          ...initial,
          entries: [],
          sources: [source(upper)],
          nextCursors: {},
          errors: [failed],
          viewers: { [issueListCursorKey(upper)]: "B" },
        },
        completed.firstCursors,
      );
      expect(unavailable.entries).toEqual(completed.entries);
      expect(unavailable.nextCursors).toEqual({ [upperCursor]: "3" });
      expect(unavailable.restartSources).toEqual([]);
      const retried = continueIssueListPage(
        unavailable,
        { [upperCursor]: "3" },
        {
          ...initial,
          entries: [],
          sources: [source(upper)],
          nextCursors: {},
          viewers: { [issueListCursorKey(upper)]: "B" },
        },
        unavailable.firstCursors,
      );
      expect(retried.entries).toEqual([row("9001", current)]);
      expect(retried.errors).toEqual([]);
      expect(retried.restartSources).toEqual([source(upper)]);
    },
  );

  it.each([false, true])(
    "rebinds owner and repository case aliases within one native mount, legacy: %s",
    (legacy) => {
      const upper = row("42", {
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Root/Mount/ACME/Web",
        projectId: "old" as ProjectId,
      });
      const lower = row("42", {
        ...upper,
        scope: "Root/mount/acme/web",
        projectId: "lower" as ProjectId,
      });
      const current = {
        ...upper,
        scope: "Root/Mount/acme/web",
        projectId: "current" as ProjectId,
        projectTitle: "Current",
      };
      const cursorFor = (entry: IssueListEntry) =>
        legacy ? `${entry.host} ${entry.scope}` : issueListCursorKey(entry);
      const oldCursor = cursorFor(upper);
      const nextCursor = cursorFor(current);
      const otherCursor = cursorFor(lower);
      const page = {
        ...answer([upper, lower], { [oldCursor]: "2", [otherCursor]: "other-2" }),
        sources: [source(upper), source(lower)],
        viewers: { [issueListCursorKey(upper)]: "A", [issueListCursorKey(lower)]: "A" },
      };
      const held = first(page);
      const continued = continueIssueListPage(
        held,
        { [oldCursor]: "2" },
        {
          ...page,
          entries: [row("43", current)],
          sources: [source(current)],
          nextCursors: { [nextCursor]: "3" },
        },
        held.firstCursors,
      );
      const rebound = {
        ...upper,
        projectId: current.projectId,
        projectTitle: current.projectTitle,
      };
      expect(continued.entries).toEqual([rebound, lower, row("43", current)]);
      expect(continued.sources).toEqual([source(rebound), source(lower)]);
      expect(continued.firstKeys).toEqual(new Set([issueEntryKey(current), issueEntryKey(lower)]));
      expect(continued.restartSources).toEqual([]);
      const refreshed = refreshIssueListPage(
        continued,
        {
          ...page,
          entries: [{ ...current, title: "Fresh native title" }],
          sources: [source(current)],
          nextCursors: { [nextCursor]: "2" },
        },
        { source: current },
      );
      expect(refreshed.entries).toEqual([
        lower,
        row("43", current),
        { ...current, title: "Fresh native title" },
      ]);
      expect(refreshed.nextCursors).toEqual({ [nextCursor]: "3", [otherCursor]: "other-2" });
      expect(refreshed.firstCursors).toEqual({ [nextCursor]: "2", [otherCursor]: "other-2" });
    },
  );

  it("restarts both native mounts when both authoritative viewers change", () => {
    const upper = row("42", {
      tracker: "forgejo" as IssueTrackerKind,
      host: "forge.example",
      scope: "Mount/acme/web",
    });
    const lower = row("42", { ...upper, scope: "mount/acme/web" });
    const page = {
      ...answer([upper, lower], {
        [issueListCursorKey(upper)]: "2",
        [issueListCursorKey(lower)]: "2",
      }),
      sources: [source(upper), source(lower)],
      viewers: { [issueListCursorKey(upper)]: "A", [issueListCursorKey(lower)]: "A" },
    };
    const held = first(page);
    const next = continueIssueListPage(
      held,
      held.nextCursors,
      {
        ...page,
        entries: [],
        nextCursors: {},
        viewers: { [issueListCursorKey(upper)]: "B", [issueListCursorKey(lower)]: "B" },
      },
      held.firstCursors,
    );
    expect(next.entries).toEqual([]);
    expect(next.restartSources).toEqual([source(upper), source(lower)]);
  });

  it.each([
    { from: cursor, to: "github.com acme/app", migrateFirst: false },
    { from: cursor, to: "github.com acme/app", migrateFirst: true },
    { from: "github.com acme/app", to: cursor, migrateFirst: false },
    { from: "github.com acme/app", to: cursor, migrateFirst: true },
  ])("resets viewer cursors across native cursor aliases: %j", ({ from, to, migrateFirst }) => {
    const other = row("other-first", {
      tracker: "gitlab" as IssueTrackerKind,
      projectId: "other" as ProjectId,
    });
    const otherCursor = "gitlab github.com acme/app";
    const initial = {
      ...answer([row("first"), other], { [from]: "A2", [otherCursor]: "O2" }),
      sources: [source(row("first")), source(other)],
      viewers: { "github github.com": "A", "gitlab github.com": "other" },
    };
    const held = first(initial);
    const continued = continueIssueListPage(
      held,
      held.nextCursors,
      {
        ...initial,
        entries: [row("A-tail"), row("other-tail", other)],
        nextCursors: { [from]: "A3", [otherCursor]: "O3" },
      },
      held.firstCursors,
    );
    const before = migrateFirst
      ? continueIssueListPage(
          continued,
          { [from]: "A3" },
          {
            ...initial,
            entries: [row("A-more")],
            nextCursors: { [to]: "A4" },
          },
          continued.firstCursors,
        )
      : continued;
    const sent = migrateFirst ? { [to]: "A4" } : { [from]: "A3" };
    const switched = continueIssueListPage(
      before,
      sent,
      {
        ...initial,
        viewers: { "github github.com": "B" },
        entries: [row("B-first")],
        nextCursors: { [to]: "B2" },
      },
      before.firstCursors,
    );
    expect(keys(switched).toSorted()).toEqual(["B-first", "other-first", "other-tail"]);
    expect(switched.nextCursors).toEqual({ [to]: "B2", [otherCursor]: "O3" });
    expect(switched.firstCursors).toEqual({ [to]: "B2", [otherCursor]: "O2" });
    expect(switched.firstKeys).toEqual(
      new Set([issueEntryKey(row("B-first")), issueEntryKey(other)]),
    );
  });

  it.each([cursor, "github.com acme/app"])(
    "drops old private rows and resets %s on a changed or missing viewer",
    (key) => {
      for (const viewer of ["B", null]) {
        const held = loaded(key);
        const fresh = answer(
          [row("first", { title: "Shared issue under B" })],
          { [key]: "B2" },
          viewer,
        );
        const next = refreshIssueListPage(held, fresh);
        expect(keys(next)).toEqual(["first"]);
        expect(next.nextCursors).toEqual(fresh.nextCursors);
        expect(next.firstCursors).toEqual(fresh.nextCursors);
        expect(next.firstKeys).toEqual(new Set([issueEntryKey(row("first"))]));
      }
    },
  );

  it.each(["B", null])(
    "resets legacy host-only viewer A to %s without losing unrelated hosts",
    (viewer) => {
      const remote = row("remote", { host: "github.corp" });
      const initial = {
        ...answer([row("first"), remote], { [cursor]: "A2" }),
        viewers: { "github.com": "A", "github.corp": "remote" },
        sources: [source(row("first")), source(remote)],
      };
      const held = first(initial);
      const continued = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("A-tail")],
          nextCursors: { [cursor]: "A3" },
        },
        held.firstCursors,
      );
      const fresh = {
        ...initial,
        entries: [row("B-first"), remote],
        viewers:
          viewer === null
            ? { "github.corp": "remote" }
            : { "github.com": viewer, "github.corp": "remote" },
        nextCursors: { [cursor]: "B2" },
      };
      const next = refreshIssueListPage(continued, fresh);
      expect(keys(next)).toEqual(["B-first", "remote"]);
      expect(next.nextCursors).toEqual({ [cursor]: "B2" });
      const switched = continueIssueListPage(
        continued,
        continued.nextCursors,
        {
          ...fresh,
          entries: [row("B-first")],
        },
        continued.firstCursors,
      );
      expect(keys(switched)).toEqual(["remote", "B-first"]);
      expect(switched.nextCursors).toEqual({ [cursor]: "B2" });
    },
  );

  it.each([true, false])(
    "does not borrow a host-only viewer across trackers, with source metadata %s",
    (sources) => {
      const other = row("other", {
        tracker: "gitlab" as IssueTrackerKind,
        projectId: "other" as ProjectId,
      });
      const initial = {
        ...answer([row("first")], { [cursor]: "A2" }),
        sources: sources ? [source(row("first")), source(other)] : undefined,
        trackers: [row("first"), other].map((entry) => ({
          tracker: entry.tracker,
          host: entry.host,
          projectCount: 1,
          configured: true,
          capabilities: {} as IssueCapabilities,
          detail: null,
        })),
        viewers: { "github github.com": "A", "gitlab github.com": "other", "github.com": "legacy" },
      };
      const held = first(initial);
      const continued = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("A-tail")],
          nextCursors: { [cursor]: "A3" },
        },
        held.firstCursors,
      );
      const ambiguous = refreshIssueListPage(continued, {
        ...initial,
        viewers: { "github.com": "B" },
      });
      expect(keys(ambiguous)).toEqual(["A-tail", "first"]);
      expect(ambiguous.nextCursors).toEqual({ [cursor]: "A3" });
      const resolved = refreshIssueListPage(ambiguous, {
        ...initial,
        entries: [row("B-first")],
        viewers: { "github github.com": "B" },
        nextCursors: { [cursor]: "B2" },
      });
      expect(keys(resolved)).toEqual(["B-first"]);
      expect(resolved.nextCursors).toEqual({ [cursor]: "B2" });
    },
  );

  it("keeps pagination for the same viewer and for pages without viewer context", () => {
    const held = loaded();
    for (const fresh of [
      answer([row("first")], { [cursor]: "A2" }),
      { entries: [row("first")], nextCursors: { [cursor]: "A2" }, errors: [] },
    ]) {
      const next = refreshIssueListPage(held, fresh);
      expect(keys(next)).toEqual(["A-tail", "first"]);
      expect(next.nextCursors).toEqual({ [cursor]: "A3" });
    }
  });

  it.each(["refresh", "continue"])(
    "keeps failed and unrelated sources during %s, then drops a recovered source's old viewer tail",
    (operation) => {
      const failed = row("failed-first", {
        scope: "acme/failed",
        projectId: "failed" as ProjectId,
      });
      const other = row("other-first", {
        tracker: "gitlab" as IssueTrackerKind,
        projectId: "other" as ProjectId,
      });
      const failedCursor = "github github.com acme/failed";
      const otherCursor = "gitlab github.com acme/app";
      const initial = {
        ...answer([row("first"), failed, other], {
          [cursor]: "A2",
          [failedCursor]: "F2",
          [otherCursor]: "O2",
        }),
        sources: [source(row("first")), source(failed), source(other)],
        viewers: { "github github.com": "A", "gitlab github.com": "other" },
      };
      const held = first(initial);
      const continued = continueIssueListPage(
        held,
        held.nextCursors,
        {
          ...initial,
          entries: [row("A-tail"), row("failed-tail", failed), row("other-tail", other)],
          nextCursors: { [cursor]: "A3", [failedCursor]: "F3", [otherCursor]: "O3" },
        },
        held.firstCursors,
      );
      const fresh = {
        ...initial,
        viewers: { "github github.com": "B", "gitlab github.com": "other" },
        entries: [row("B-first"), other],
        nextCursors: { [cursor]: "B2", [otherCursor]: "O2" },
        errors: [
          {
            projectId: failed.projectId,
            projectTitle: failed.projectTitle,
            tracker: failed.tracker,
            host: failed.host,
            message: "unavailable",
          },
        ],
      };
      const next =
        operation === "refresh"
          ? refreshIssueListPage(continued, fresh)
          : continueIssueListPage(
              continued,
              { [cursor]: "A3", [failedCursor]: "F3" },
              {
                ...fresh,
                entries: [row("B-first")],
                viewers: { "github github.com": "B" },
                nextCursors: { [cursor]: "B2" },
              },
              continued.firstCursors,
            );
      expect(keys(next).toSorted()).toEqual([
        "B-first",
        "failed-first",
        "failed-tail",
        "other-first",
        "other-tail",
      ]);
      expect(next.nextCursors).toEqual({
        [cursor]: "B2",
        [failedCursor]: "F3",
        [otherCursor]: "O3",
      });
      const recovered = refreshIssueListPage(
        next,
        {
          ...answer([row("recovered", failed)], { [failedCursor]: "B2" }, "B"),
          sources: [source(failed)],
        },
        { source: failed },
      );
      expect(keys(recovered).toSorted()).toEqual([
        "B-first",
        "other-first",
        "other-tail",
        "recovered",
      ]);
      expect(recovered.nextCursors).toEqual({
        [cursor]: "B2",
        [failedCursor]: "B2",
        [otherCursor]: "O3",
      });
    },
  );

  it("limits a continued viewer change to the requested scopes and native host", () => {
    const sibling = row("sibling", { scope: "acme/sibling" });
    const remote = row("remote", { host: "github.corp" });
    const siblingCursor = "github github.com acme/sibling";
    const remoteCursor = "github github.corp acme/app";
    const page = {
      ...answer([row("first"), sibling, remote], {
        [cursor]: "A2",
        [siblingCursor]: "S2",
        [remoteCursor]: "R2",
      }),
      sources: [source(row("first")), source(sibling), source(remote)],
      viewers: { "github github.com": "A", "github github.corp": "remote" },
    };
    const held = first(page);
    const next = continueIssueListPage(
      held,
      { [cursor]: "A2" },
      {
        ...answer([row("B-first")], { [cursor]: "B2" }, "B"),
        sources: page.sources,
      },
      held.firstCursors,
    );
    expect(keys(next).toSorted()).toEqual(["B-first", "remote", "sibling"]);
    expect(next.nextCursors).toEqual({
      [cursor]: "B2",
      [siblingCursor]: "S2",
      [remoteCursor]: "R2",
    });
    expect(next.firstCursors).toEqual(next.nextCursors);
  });

  it("uses the continued viewer instead of the original answer on the next refresh", () => {
    const held = loaded();
    const switched = continueIssueListPage(
      held,
      held.nextCursors,
      answer([row("B-first")], { [cursor]: "B2" }, "B"),
      held.firstCursors,
    );
    expect(keys(switched)).toEqual(["B-first"]);
    expect(switched.firstCursors).toEqual({ [cursor]: "B2" });
    const continued = continueIssueListPage(
      switched,
      switched.nextCursors,
      answer([row("B-tail")], { [cursor]: "B3" }, "B"),
      switched.firstCursors,
    );
    const next = refreshIssueListPage(continued, answer([row("B-first")], { [cursor]: "B2" }, "B"));
    expect(keys(next)).toEqual(["B-tail", "B-first"]);
    expect(next.nextCursors).toEqual({ [cursor]: "B3" });
    expect(keys(refreshIssueListPage(next, answer([row("A-again")], { [cursor]: "A2" })))).toEqual([
      "A-again",
    ]);
  });

  it.each([
    { cursor: "gitlab shared.example acme/app", viewer: "B" },
    { cursor: "shared.example acme/app", viewer: "B" },
    { cursor: "gitlab shared.example acme/app", viewer: "A" },
    { cursor: "shared.example acme/app", viewer: "A" },
  ])("restarts a changed viewer from page one once: %j", async ({ cursor, viewer }) => {
    const { atoms, registry, dispose } = issueReadHarness();
    const native = row("A-first", {
      tracker: "gitlab" as IssueTrackerKind,
      host: "shared.example",
      projectId: "old" as ProjectId,
    });
    const current = { ...native, projectId: "current" as ProjectId };
    const failed = row("failed-first", {
      ...native,
      projectId: "failed" as ProjectId,
      scope: "acme/failed",
    });
    const unrelated = row("other-first", { host: native.host });
    const failedCursor = "gitlab shared.example acme/failed";
    const otherCursor = "github shared.example acme/app";
    const firstRows = Array.from({ length: 50 }, (_, index) => row(`A-${index}`, native));
    const initial = {
      ...answer([...firstRows, failed, unrelated], {
        [cursor]: "2",
        [failedCursor]: "failed-2",
        [otherCursor]: "other-2",
      }),
      sources: [source(native), source(failed), source(unrelated)],
      viewers: { "gitlab shared.example": "A", "github shared.example": "other" },
    };
    const pageTwo = {
      ...initial,
      entries: viewer === "B" ? [] : [row("A-tail", current)],
      sources: [source(current), source(current), source(failed)],
      viewers: { "gitlab shared.example": viewer },
      nextCursors: {},
      errors: [
        {
          projectId: failed.projectId,
          projectTitle: failed.projectTitle,
          tracker: failed.tracker,
          host: failed.host,
          message: "unavailable",
        },
      ],
    };
    const firstForB = {
      ...initial,
      entries: [row("B-only", current)],
      sources: [source(current)],
      viewers: { "gitlab shared.example": "B" },
      nextCursors: {},
    };
    const replies = viewer === "B" ? [initial, pageTwo, firstForB] : [initial, pageTwo];
    const request = vi.spyOn(RpcClient, "requestGuarded");
    request.mockImplementation((() => Effect.succeed(replies.shift()!)) as unknown as Parameters<
      typeof request.mockImplementation
    >[0]);
    const read = async (input: IssueListInput) => {
      const result = await atoms.listPage.run(registry, {
        environmentId: "environment" as EnvironmentId,
        input,
      });
      if (result._tag !== "Success") throw new Error("list read failed");
      return result.value;
    };
    try {
      const input = { state: "all" as const, involvement: "assigned" as const, limit: 50 };
      const held = first(await read(input));
      const sent = { [cursor]: "2", [failedCursor]: "failed-2" };
      const next = continueIssueListPage(
        held,
        sent,
        await read({ ...input, cursors: sent }),
        held.firstCursors,
      );
      let completed = next;
      for (const restart of next.restartSources ?? []) {
        const fresh = await read({ ...input, projectId: restart.projectId, host: restart.host });
        completed = refreshIssueListPage(completed, fresh, {
          source: { ...restart, host: restart.host! },
        });
      }
      expect(request.mock.calls.map(([tag]) => tag)).toEqual(
        Array(viewer === "B" ? 3 : 2).fill("issues.list"),
      );
      expect(request.mock.calls.map(([, payload]) => payload)).toEqual([
        input,
        { ...input, cursors: sent },
        ...(viewer === "B" ? [{ ...input, projectId: current.projectId, host: current.host }] : []),
      ]);
      expect(replies).toEqual([]);
      expect(keys(completed).toSorted()).toEqual(
        (viewer === "B"
          ? ["B-only", "failed-first", "other-first"]
          : [...firstRows.map((row) => row.key), "A-tail", "failed-first", "other-first"]
        ).toSorted(),
      );
      expect(completed.nextCursors).toEqual({
        [failedCursor]: "failed-2",
        [otherCursor]: "other-2",
      });
      expect(completed.errors).toEqual(pageTwo.errors);
      if (viewer === "B")
        expect(completed.firstKeys).toEqual(
          new Set([
            issueEntryKey(row("B-only", current)),
            issueEntryKey(failed),
            issueEntryKey(unrelated),
          ]),
        );
      expect(next.restartSources).toEqual(viewer === "B" ? [source(current)] : []);
      expect(completed.restartSources).toEqual([]);
      const stale = continueIssueListPage(next, sent, pageTwo, held.firstCursors);
      expect(stale).toBe(next);
    } finally {
      dispose();
      request.mockRestore();
    }
  });

  it.each(["assigned", "all"] as const)(
    "resets %s rows using only the requested list reads",
    async (involvement) => {
      const { atoms, registry, dispose } = issueReadHarness();
      const replies = [
        answer([row("A-first")], { [cursor]: "A2" }),
        answer([row("A-tail")], { [cursor]: "A3" }),
        answer([row("B-first")], { [cursor]: "B2" }, "B"),
      ];
      const request = vi.spyOn(RpcClient, "requestGuarded");
      request.mockImplementation((() => Effect.succeed(replies.shift()!)) as unknown as Parameters<
        typeof request.mockImplementation
      >[0]);
      const target = {
        environmentId: "environment" as EnvironmentId,
        input: { state: "all" as const, involvement },
      };
      try {
        const read = async (cursors = {}) => {
          const result = await atoms.listPage.run(registry, {
            ...target,
            input: { ...target.input, cursors },
          });
          if (result._tag !== "Success") throw new Error("list read failed");
          return result.value;
        };
        const held = first(await read());
        const continued = continueIssueListPage(
          held,
          held.nextCursors,
          await read(held.nextCursors),
          held.firstCursors,
        );
        const next = refreshIssueListPage(continued, await read());
        expect(request.mock.calls.map(([tag]) => tag)).toEqual([
          "issues.list",
          "issues.list",
          "issues.list",
        ]);
        expect(replies).toEqual([]);
        expect(keys(next)).toEqual(["B-first"]);
        expect(next.nextCursors).toEqual({ [cursor]: "B2" });
      } finally {
        dispose();
        request.mockRestore();
      }
    },
  );
});
