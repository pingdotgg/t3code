import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  IssueDetail,
  IssueListResult,
  IssueTrackerKind,
  ProjectId,
  WS_METHODS,
  issueListCursorKey,
  type AuthSessionState,
  type IssueCapabilities,
  type IssueListEntry,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
  issueEntryKey,
  issueListCursorsOn,
  issueScopeKey,
  issueSourceMatchesList,
  mergeIssueListPage,
  refreshIssueListPage,
} from "./issues.ts";

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
const entry = (connectionId?: string, key = "ENG-1"): IssueListEntry => ({
  ...(connectionId === undefined ? {} : { connectionId }),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  tracker: IssueTrackerKind.make("linear"),
  host: "linear.app",
  scope: "ENG",
  key,
  displayKey: key,
  title: `${connectionId ?? "default"} ${key}`,
  url: `https://linear.app/team/issue/${key}`,
  author: null,
  state: { category: "open", name: "Open" },
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  closedAt: null,
  labels: [],
  assignees: [],
  commentCount: 0,
});
const source = (row: IssueListEntry) => ({
  projectId: row.projectId,
  projectTitle: row.projectTitle,
  tracker: row.tracker,
  host: row.host,
  scope: row.scope,
  capabilities,
  ...(row.connectionId === undefined ? {} : { connectionId: row.connectionId }),
});
const decodeList = Schema.decodeUnknownSync(IssueListResult);
const decodeDetail = Schema.decodeUnknownSync(IssueDetail);
const page = (
  entries: ReadonlyArray<IssueListEntry>,
  nextCursors: IssueListResult["nextCursors"] = {},
) =>
  decodeList({
    entries,
    sources: entries.map(source),
    nextCursors,
    trackers: [],
    errors: [],
    viewers: Object.fromEntries(entries.map((row) => [issueListCursorKey(row), "viewer"])),
  });
const first = (answer: IssueListResult) => ({
  answer,
  ...answer,
  firstCursors: answer.nextCursors,
  firstKeys: new Set(answer.entries.map(issueEntryKey)),
});
const environmentId = EnvironmentId.make("environment");

it("keeps account case and legacy identities separate in rows, scopes, cursors and list selectors", () => {
  const upper = entry("Account /A"),
    lower = entry("account /A"),
    legacy = entry();
  expect(mergeIssueListPage([upper, lower], [legacy])).toHaveLength(3);
  expect(issueScopeKey(environmentId, upper)).not.toBe(issueScopeKey(environmentId, lower));
  expect(issueScopeKey(environmentId, legacy)).toBe(
    JSON.stringify([environmentId, "linear", "linear.app", "eng"]),
  );
  const cursors = Object.fromEntries(
    [upper, lower, legacy].map((row) => [issueListCursorKey(row), "2"]),
  );
  expect(issueListCursorsOn(cursors, "LINEAR.APP", "linear", upper.connectionId)).toEqual({
    [issueListCursorKey(upper)]: "2",
  });
  expect(issueListCursorsOn(cursors, "linear.app", "linear")).toEqual({
    [issueListCursorKey(legacy)]: "2",
  });
  expect(issueSourceMatchesList({ state: "all", connectionId: upper.connectionId }, lower)).toBe(
    false,
  );
  expect(issueSourceMatchesList({ state: "all" }, lower)).toBe(true);
});

it.each(["linear", "forgejo"])(
  "isolates scoped viewers, failures and restarts between %s accounts",
  (tracker) => {
    const upper = {
      ...entry("Account"),
      tracker: IssueTrackerKind.make(tracker),
      scope: tracker === "forgejo" ? "Mount/Acme/Web" : "ENG",
    };
    const lower = { ...upper, connectionId: "account" };
    const cursor = issueListCursorKey(upper),
      other = issueListCursorKey(lower);
    const initial = page([upper, lower], { [cursor]: "2", [other]: "2" });
    const held = first(initial);
    const loaded = continueIssueListPage(
      held,
      held.nextCursors,
      page(
        [
          { ...upper, key: "tail" },
          { ...lower, key: "tail" },
        ],
        { [cursor]: "3", [other]: "3" },
      ),
      held.firstCursors,
    );
    expect(loaded.entries).toHaveLength(4);
    const switched = continueIssueListPage(
      loaded,
      { [cursor]: "3" },
      {
        ...page([upper], { [cursor]: "B2" }),
        viewers: { [cursor]: "new-viewer" },
      },
      loaded.firstCursors,
    );
    expect(switched.entries.map((row) => [row.connectionId, row.key]).toSorted()).toEqual(
      [
        ["Account", "ENG-1"],
        ["account", "ENG-1"],
        ["account", "tail"],
      ].toSorted(),
    );
    expect(switched.nextCursors).toEqual({ [cursor]: "B2", [other]: "3" });
    expect(switched.restartSources).toHaveLength(1);
    expect(switched.restartSources![0]).toMatchObject({
      connectionId: "Account",
      scope: upper.scope,
    });
    const failed = refreshIssueListPage(loaded, {
      ...page([lower], { [other]: "2" }),
      sources: initial.sources,
      errors: [{ ...source(upper), message: "Account unavailable" }],
    });
    expect(failed.entries.filter((row) => row.connectionId === "Account")).toHaveLength(2);
    expect(failed.nextCursors[cursor]).toBe("3");
    const unknown = refreshIssueListPage(
      loaded,
      {
        ...page([upper], { [cursor]: "2" }),
        viewers: { [`${tracker} linear.app`]: "other-account-viewer" },
      },
      { source: upper },
    );
    expect(unknown.entries).toHaveLength(4);
    expect(unknown.nextCursors).toEqual(loaded.nextCursors);
  },
);

it("drops a replaced binding and rejects its late continuation without lending old tails or cursors", () => {
  const old = entry("old"),
    current = entry("new"),
    other = { ...entry("other"), projectId: ProjectId.make("other") };
  const cursor = issueListCursorKey(old),
    otherCursor = issueListCursorKey(other);
  const held = first(page([old, other], { [cursor]: "2", [otherCursor]: "o2" }));
  const loaded = continueIssueListPage(
    held,
    held.nextCursors,
    page(
      [
        { ...old, key: "tail" },
        { ...other, key: "tail" },
      ],
      { [cursor]: "3", [otherCursor]: "o3" },
    ),
    held.firstCursors,
  );
  const fresh = refreshIssueListPage(
    loaded,
    page([current, other], { [issueListCursorKey(current)]: "2", [otherCursor]: "o2" }),
  );
  expect(fresh.entries.map((row) => row.connectionId)).toEqual(["other", "new", "other"]);
  expect(fresh.nextCursors).toEqual({ [issueListCursorKey(current)]: "2", [otherCursor]: "o3" });
  expect(
    continueIssueListPage(
      fresh,
      { [cursor]: "3" },
      page([{ ...old, key: "late" }]),
      loaded.firstCursors,
    ),
  ).toBe(fresh);
});

it.effect(
  "refreshes only the selected account's mounted detail, history and hierarchy after a write",
  () =>
    Effect.gen(function* () {
      const supervisor = {
        state: yield* SubscriptionRef.make({ phase: "connected" } as const),
        session: yield* SubscriptionRef.make(Option.some({})),
      } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
      yield* Effect.promise(async () => {
        const runtime = Atom.runtime(
          Layer.succeed(
            EnvironmentRegistry.EnvironmentRegistry,
            EnvironmentRegistry.EnvironmentRegistry.of({
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
            } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          ),
        );
        const session: AuthSessionState = {
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        };
        const sessionAtom = Atom.make(AsyncResult.success(session));
        const sessions = vi
          .spyOn(Session, "createEnvironmentSessionAtoms")
          .mockReturnValue({ sessionStateAtom: () => sessionAtom } as unknown as ReturnType<
            typeof Session.createEnvironmentSessionAtoms
          >);
        const reads: Array<{ tag: string; connectionId: string | undefined; key: string }> = [];
        let written = false;
        const request = vi.spyOn(RpcClient, "request").mockImplementation(((
          tag: string,
          input: { connectionId?: string; key: string },
        ) =>
          Effect.sync(() => {
            reads.push({ tag, connectionId: input.connectionId, key: input.key });
            if (tag === WS_METHODS.issuesHierarchy)
              return {
                parent: input.connectionId === "Account" ? { scope: "ENG", key: "ENG-0" } : null,
                children: { items: [], nextCursor: null },
              };
            if (tag === WS_METHODS.issuesHistory) return { items: [], nextCursor: null };
            return decodeDetail({
              ...entry(input.connectionId),
              title: written && input.connectionId === "Account" ? "Changed" : "Original",
              capabilities,
              writable: true,
              viewerPermissions: {
                setState: true,
                comment: true,
                edit: true,
                labels: true,
                assignees: true,
              },
              viewer: "viewer",
              body: "",
              comments: [],
              commentsCursor: null,
              events: [],
              linkedPullRequests: [],
            });
          })) as unknown as typeof RpcClient.request);
        const guarded = vi.spyOn(RpcClient, "requestGuarded");
        guarded.mockImplementation((() =>
          Effect.sync(() => {
            written = true;
            return {};
          })) as unknown as Parameters<typeof guarded.mockImplementation>[0]);
        const atoms = createIssueEnvironmentAtoms(runtime),
          registry = AtomRegistry.make();
        const references = [entry("Account"), entry("account"), entry()].map((row) => ({
          projectId: row.projectId,
          tracker: row.tracker,
          host: row.host,
          scope: row.scope,
          ...(row.connectionId === undefined ? {} : { connectionId: row.connectionId }),
        }));
        const queries: Array<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>> = [
          ...references.flatMap((reference) => [
            atoms.detail({ environmentId, input: { ...reference, key: "ENG-1" } }),
            atoms.history({ environmentId, input: { ...reference, key: "ENG-1" } }),
            atoms.hierarchy({ environmentId, input: { ...reference, key: "ENG-1" } }),
          ]),
          ...references.map((reference) =>
            atoms.history({ environmentId, input: { ...reference, key: "ENG-0" } }),
          ),
        ];
        const releases = queries.map((query) => registry.mount(query));
        try {
          await Promise.all(queries.map((query) => executeAtomQuery(registry, query)));
          const before = reads.length;
          const result = await atoms.setParent.run(registry, {
            environmentId,
            input: { ...references[0]!, key: "ENG-1", parentKey: null },
          });
          expect(result._tag).toBe("Success");
          await Promise.all(queries.map((query) => executeAtomQuery(registry, query)));
          expect(
            reads
              .slice(before)
              .map(({ tag, connectionId, key }) => [tag, connectionId, key])
              .toSorted(),
          ).toEqual(
            [
              [WS_METHODS.issuesDetail, "Account", "ENG-1"],
              [WS_METHODS.issuesHistory, "Account", "ENG-1"],
              [WS_METHODS.issuesHistory, "Account", "ENG-0"],
              [WS_METHODS.issuesHierarchy, "Account", "ENG-1"],
            ].toSorted(),
          );
          expect(guarded).toHaveBeenCalledExactlyOnceWith(
            WS_METHODS.issuesSetParent,
            expect.objectContaining({ connectionId: "Account" }),
          );
          expect(registry.get(queries[0]!)).toMatchObject({
            value: { title: "Changed", connectionId: "Account" },
          });
          expect(registry.get(queries[3]!)).toMatchObject({
            value: { title: "Original", connectionId: "account" },
          });
        } finally {
          releases.forEach((release) => release());
          registry.dispose();
          request.mockRestore();
          guarded.mockRestore();
          sessions.mockRestore();
        }
      });
    }),
);

it("keeps Jira mount case distinct when selecting cursors and filtering sources", () => {
  const source = {
    ...entry("ExactB"),
    tracker: IssueTrackerKind.make("jira"),
    host: "jira.example:8443/Jira",
  };
  const other = { ...source, host: "jira.example:8443/jira" };
  const cursors = { [issueListCursorKey(source)]: "upper", [issueListCursorKey(other)]: "lower" };
  expect(issueListCursorsOn(cursors, "JIRA.EXAMPLE:8443/Jira", "jira", "ExactB")).toEqual({
    [issueListCursorKey(source)]: "upper",
  });
  expect(issueSourceMatchesList({ state: "all", host: source.host }, other)).toBe(false);
  expect(issueEntryKey(source)).not.toBe(issueEntryKey(other));
});
