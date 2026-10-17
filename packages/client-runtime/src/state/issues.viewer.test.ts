import type {
  EnvironmentId,
  IssueCapabilities,
  IssueListEntry,
  IssueListInput,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";
import { IssueListResult, issueListCursorKey } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcClient from "../rpc/client.ts";
import { executeAtomQuery } from "./runtime.ts";
import {
  continueIssueListPage,
  createIssueEnvironmentAtoms,
  issueEntryKey,
  issueScopeKey,
  refreshIssueListPage,
} from "./issues.ts";

const row = (key: string, overrides: Partial<IssueListEntry> = {}): IssueListEntry => ({
  tracker: "github" as IssueTrackerKind,
  host: "github.com",
  scope: "acme/app",
  projectId: "app" as ProjectId,
  projectTitle: "App",
  displayKey: `#${key}`,
  title: key,
  url: `https://github.com/acme/app/issues/${key}`,
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  ...overrides,
  key,
});
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

describe("held issue list viewers", () => {
  it.each(["gitlab gitlab.example group/app", "gitlab.example group/app"])(
    "keeps a completed 75-row scope terminal after an unchanged first refresh: %s",
    async (cursor) => {
      const supervisor = {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
      const runtime = Atom.runtime(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            run: (_environmentId, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
      );
      const registry = AtomRegistry.make();
      const atoms = createIssueEnvironmentAtoms(runtime);
      const nativeRows = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, index) => row(String(from + index))).map(
          (row) => ({
            ...row,
            tracker: "gitlab" as IssueTrackerKind,
            host: "gitlab.example",
            scope: "group/app",
          }),
        );
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
        expect(refreshed.nextCursors).toEqual({});
        expect(refreshed.entries.toSorted((a, b) => Number(a.key) - Number(b.key))).toEqual(
          nativeRows(1, 75),
        );
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
        registry.dispose();
        request.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "keeps completed native mounts separate through a scoped case-alias refresh, legacy: %s",
    (legacy) => {
      const upper = row("42", {
        tracker: "forgejo" as IssueTrackerKind,
        host: "forge.example",
        scope: "Root/Mount/ACME/Web",
      });
      const lower = row("42", {
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
      const tail = row("tail", upper);
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
    { cursor: "gitlab shared.example acme/app", viewer: "B" },
    { cursor: "shared.example acme/app", viewer: "B" },
    { cursor: "gitlab shared.example acme/app", viewer: "A" },
    { cursor: "shared.example acme/app", viewer: "A" },
  ])("restarts a changed viewer from page one once: %j", async ({ cursor, viewer }) => {
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_id, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
            ),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    );
    const atoms = createIssueEnvironmentAtoms(runtime);
    const registry = AtomRegistry.make();
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
      registry.dispose();
      request.mockRestore();
    }
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
        const fresh = answer([row("B-first")], { [key]: "B2" }, viewer);
        const next = refreshIssueListPage(held, fresh);
        expect(keys(next)).toEqual(["B-first"]);
        expect(next.nextCursors).toEqual(fresh.nextCursors);
        expect(next.firstCursors).toEqual(fresh.nextCursors);
        expect(next.firstKeys).toEqual(new Set([issueEntryKey(row("B-first"))]));
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

  it.each(["assigned", "all"] as const)(
    "resets %s rows using only the requested list reads",
    async (involvement) => {
      const supervisor = {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
      const runtime = Atom.runtime(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            run: (_environmentId, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
      );
      const registry = AtomRegistry.make();
      const atoms = createIssueEnvironmentAtoms(runtime);
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
        expect(keys(next)).toEqual(["B-first"]);
        expect(next.nextCursors).toEqual({ [cursor]: "B2" });
        expect(request.mock.calls.map(([tag]) => tag)).toEqual([
          "issues.list",
          "issues.list",
          "issues.list",
        ]);
        expect(replies).toEqual([]);
      } finally {
        registry.dispose();
        request.mockRestore();
      }
    },
  );
});
