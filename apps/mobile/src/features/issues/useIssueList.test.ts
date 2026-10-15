// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueCapabilities,
  type IssueListInput,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";

import * as RpcClient from "../../../../../packages/client-runtime/src/rpc/client.ts";
import * as EnvironmentRegistry from "../../../../../packages/client-runtime/src/connection/registry.ts";
import * as EnvironmentSupervisor from "../../../../../packages/client-runtime/src/connection/supervisor.ts";
import { AVAILABLE_CONNECTION_STATE } from "../../../../../packages/client-runtime/src/connection/model.ts";
import type { RpcSession } from "../../../../../packages/client-runtime/src/rpc/session.ts";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import * as Layer from "effect/Layer";

vi.mock("../../state/issues", () => ({ issueEnvironment: {} }));

import { issueEnvironment } from "../../state/issues";
import { useIssueList, type IssueListTarget } from "./useIssueList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (key: string, overrides: Partial<IssueListEntry> = {}): IssueListEntry => ({
  tracker: IssueTrackerKind.make("gitlab"),
  host: "gitlab.example",
  scope: "group/app",
  displayKey: `#${key}`,
  title: key,
  url: `https://gitlab.example/group/app/-/issues/${key}`,
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  ...overrides,
  key,
});
const source = (entry: IssueListEntry) => ({ ...entry, capabilities: {} as IssueCapabilities });
const cursor = "gitlab gitlab.example group/app";
const failedCursor = "gitlab gitlab.example group/failed";
const otherCursor = "github github.example group/other";

it.each([
  { viewer: "A", switchFilter: false, companion: null },
  { viewer: "B", switchFilter: false, companion: null },
  { viewer: "B", switchFilter: true, companion: null },
  { viewer: "A", switchFilter: false, companion: "waiting" },
  { viewer: "A", switchFilter: false, companion: "failed" },
  { viewer: "B", switchFilter: false, companion: "ready" },
  { viewer: "B", switchFilter: false, companion: null, restartFailure: "request" },
  { viewer: "B", switchFilter: false, companion: null, restartFailure: "source" },
])(
  "restarts only the current changed viewer from page one: %j",
  async ({ viewer, switchFilter, companion, restartFailure }) => {
    const firstRows = Array.from({ length: 50 }, (_, index) => row(`A-${index}`));
    const failed = row("failed", { scope: "group/failed", projectId: ProjectId.make("failed") });
    const other = row("other", {
      tracker: IssueTrackerKind.make("github"),
      host: "github.example",
      scope: "group/other",
      projectId: ProjectId.make("other"),
    });
    const otherTail = row("other-tail", other);
    const first: IssueListResult = {
      entries: [...firstRows, ...(restartFailure ? [] : [failed]), other],
      sources: [source(firstRows[0]!), ...(restartFailure ? [] : [source(failed)]), source(other)],
      nextCursors: {
        [cursor]: "2",
        ...(restartFailure ? {} : { [failedCursor]: "F2" }),
        [otherCursor]: "O2",
      },
      viewers: { "gitlab gitlab.example": "A", "github github.example": "other" },
      trackers: [],
      errors: [],
    };
    const continued: IssueListResult = {
      ...first,
      entries: [otherTail],
      viewers: { ...first.viewers, "gitlab gitlab.example": viewer },
      nextCursors: { [otherCursor]: "O3" },
      errors: restartFailure
        ? []
        : [
            {
              projectId: failed.projectId,
              projectTitle: failed.projectTitle,
              tracker: failed.tracker,
              host: failed.host,
              message: "unavailable",
            },
          ],
    };
    const fresh: IssueListResult = {
      ...continued,
      entries: [row("B-first")],
      sources: [source(firstRows[0]!)],
      nextCursors: {},
      errors: [],
    };
    const pageRequest = vi.spyOn(RpcClient, "requestGuarded");
    const restarts = viewer === "B" && !switchFilter;
    const replies = restarts ? [first, continued, fresh] : [first, continued];
    let restartFailed = false;
    const companionPage = Promise.withResolvers<IssueListResult>();
    const continuation = Promise.withResolvers<IssueListResult>();
    const started = Promise.withResolvers<void>();
    pageRequest.mockImplementation(((_tag: string, input: IssueListInput) => {
      if (companion === "ready" && input.cursors?.[cursor] === "offline-2")
        return Effect.promise(() => companionPage.promise);
      const reply = replies.shift()!;
      if (reply === fresh)
        companionPage.resolve({
          ...offline,
          entries: [row("offline-tail")],
          nextCursors: { [cursor]: "offline-3" },
        });
      if (switchFilter && reply === continued) {
        started.resolve();
        return Effect.promise(() => continuation.promise);
      }
      if (restartFailure && reply === fresh && !restartFailed) {
        restartFailed = true;
        if (restartFailure === "request") return Effect.fail(new Error("restart failed"));
        return Effect.succeed({
          ...fresh,
          entries: [],
          errors: [
            {
              projectId: firstRows[0]!.projectId,
              projectTitle: "Project",
              message: "restart failed",
            },
          ],
        });
      }
      return Effect.succeed(reply);
    }) as unknown as Parameters<typeof pageRequest.mockImplementation>[0]);
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_environmentId, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
            ),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    );
    Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
    const registry = AtomRegistry.make();
    const target: IssueListTarget = {
      environmentId: EnvironmentId.make(`environment-${viewer}-${switchFilter}-${companion}`),
      input: { state: "all", involvement: "assigned", limit: 50 },
    };
    const initial = await issueEnvironment.listPage.run(registry, target);
    if (initial._tag !== "Success") throw new Error("initial list failed");
    const offlineTarget = {
      ...target,
      environmentId: EnvironmentId.make(`${target.environmentId}-offline`),
    };
    const offline = { ...first, entries: [row("offline")], nextCursors: { [cursor]: "offline-2" } };
    const list = Atom.family((selected: IssueListTarget) =>
      Atom.make<AsyncResult.AsyncResult<IssueListResult, Error>>(
        AsyncResult.success(
          selected.environmentId === offlineTarget.environmentId ? offline : initial.value,
        ),
      ),
    );
    issueEnvironment.list = list;
    const root = createRoot(document.createElement("div"));
    let result: ReturnType<typeof useIssueList>;
    let targets = companion ? [target, offlineTarget] : [target];
    function Probe() {
      const current = useIssueList(targets);
      useLayoutEffect(() => {
        result = current;
      });
      return null;
    }
    try {
      await act(async () =>
        root.render(
          createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
        ),
      );
      expect(result!.lists[0]?.held.entries).toHaveLength(restartFailure ? 51 : 52);
      if (companion === "waiting" || companion === "failed") {
        await act(async () =>
          registry.set(
            list(offlineTarget),
            companion === "waiting"
              ? AsyncResult.waiting(registry.get(list(offlineTarget)))
              : AsyncResult.failure(Cause.fail(new Error("offline"))),
          ),
        );
      }
      if (switchFilter) {
        let pending: Promise<void>;
        await act(async () => {
          pending = result!.loadMore();
          await started.promise;
        });
        targets = [{ ...target, input: { ...target.input, state: "open" } }];
        await act(async () =>
          root.render(
            createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
          ),
        );
        await act(async () => {
          continuation.resolve(continued);
          await pending!;
        });
      } else {
        await act(async () => result!.loadMore());
      }
      expect(pageRequest.mock.calls.map(([tag]) => tag)).toEqual(
        Array(restarts ? (companion === "ready" ? 4 : 3) : 2).fill("issues.list"),
      );
      expect(pageRequest.mock.calls[1]?.[1]).toMatchObject({ cursors: first.nextCursors });
      if (restartFailure) {
        expect(result!.lists[0]?.held.entries.map((entry) => entry.key)).toEqual([
          "other",
          "other-tail",
        ]);
        expect(result!.lists[0]?.held.nextCursors).toEqual({ [otherCursor]: "O3" });
        expect(result!.loadingMore).toBe(false);
        expect(result!.refreshing).toBe(false);
        expect(result!.loadMoreError).toContain("restart failed");
        await act(async () => result!.loadMore());
        expect(pageRequest).toHaveBeenCalledTimes(3);
        replies.push(fresh);
        await act(async () => result!.loadMore(true));
        expect(pageRequest).toHaveBeenCalledTimes(4);
        expect(pageRequest.mock.calls[3]?.[1]).toEqual(pageRequest.mock.calls[2]?.[1]);
        expect(result!.loadMoreError).toBeNull();
        expect(result!.lists[0]?.held.pendingWrites.size).toBe(0);
      }
      if (restarts) {
        expect(pageRequest.mock.calls[companion === "ready" ? 3 : 2]?.[1]).toEqual({
          state: "all",
          involvement: "assigned",
          projectId: firstRows[0]!.projectId,
          host: "gitlab.example",
          limit: 50,
        });
        expect(result!.lists[0]?.held.entries.map((entry) => entry.key)).toEqual([
          ...(restartFailure ? [] : ["failed"]),
          "other",
          "other-tail",
          "B-first",
        ]);
      } else {
        expect(result!.lists[0]?.held.entries.map((entry) => entry.key)).toEqual(
          (switchFilter ? first.entries : [...first.entries, otherTail]).map((entry) => entry.key),
        );
      }
      expect(result!.lists[0]?.held.nextCursors).toEqual(
        switchFilter
          ? first.nextCursors
          : { ...(restartFailure ? {} : { [failedCursor]: "F2" }), [otherCursor]: "O3" },
      );
      expect(replies).toEqual([]);
      if (companion) {
        const held = result!.lists.find(
          (source) => source.environmentId === offlineTarget.environmentId,
        )!.held;
        expect(held.entries).toEqual(
          companion === "ready" ? [...offline.entries, row("offline-tail")] : offline.entries,
        );
        expect(held.nextCursors).toEqual(
          companion === "ready" ? { [cursor]: "offline-3" } : offline.nextCursors,
        );
        targets = [offlineTarget];
        await act(async () =>
          root.render(
            createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
          ),
        );
        expect(result!.hasMore).toBe(companion === "ready");
      }
    } finally {
      await act(async () => root.unmount());
      registry.dispose();
      pageRequest.mockRestore();
    }
  },
);

effectIt.effect.each(["connecting", "failed-connected"])(
  "manually refreshes ready targets beside a %s peer",
  (peerState) =>
    Effect.gen(function* () {
      const readyId = EnvironmentId.make(`ready-${peerState}`);
      const peerId = EnvironmentId.make(`peer-${peerState}`);
      const readyProject = ProjectId.make("ready-project");
      const peerProject = ProjectId.make("peer-project");
      const first: IssueListResult = {
        entries: Array.from({ length: 50 }, (_, index) =>
          row(`ready-${index}`, { projectId: readyProject }),
        ),
        nextCursors: { [cursor]: "2" },
        viewers: { "gitlab gitlab.example": "A" },
        trackers: [],
        errors: [],
      };
      const peer: IssueListResult = {
        ...first,
        entries: [row("peer", { projectId: peerProject })],
        nextCursors: { [cursor]: "peer-2" },
        errors:
          peerState === "connecting"
            ? [{ projectId: peerProject, projectTitle: "Peer", message: "saved warning" }]
            : [],
      };
      const supervisors = new Map<
        EnvironmentId,
        EnvironmentSupervisor.EnvironmentSupervisor["Service"]
      >();
      const runtime = Atom.runtime(
        Layer.effect(
          EnvironmentRegistry.EnvironmentRegistry,
          Effect.gen(function* () {
            for (const id of [readyId, peerId]) {
              supervisors.set(id, {
                state: yield* SubscriptionRef.make({
                  ...AVAILABLE_CONNECTION_STATE,
                  phase: "connected" as const,
                }),
                session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
              } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
            }
            return EnvironmentRegistry.EnvironmentRegistry.of({
              run: (id, effect) =>
                Effect.provideService(
                  effect,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisors.get(id)!,
                ),
              followStream: (id, stream) =>
                Stream.provideService(
                  stream,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisors.get(id)!,
                ),
            } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
          }),
        ),
      );
      Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
      const reads: Array<ProjectId | undefined> = [];
      let peerFails = false;
      const refreshed = Promise.withResolvers<void>();
      const request = vi.spyOn(RpcClient, "request");
      request.mockImplementation(((_tag: string, input: IssueListInput) =>
        Effect.suspend(() => {
          reads.push(input.projectId);
          if (
            input.projectId === readyProject &&
            reads.filter((id) => id === readyProject).length === 2
          )
            refreshed.resolve();
          return input.projectId === peerProject
            ? peerFails
              ? Effect.fail(new Error("query failed"))
              : Effect.succeed(peer)
            : Effect.succeed(first);
        })) as unknown as Parameters<typeof request.mockImplementation>[0]);
      const page = vi.spyOn(RpcClient, "requestGuarded");
      page.mockImplementation((() =>
        Effect.succeed({
          ...first,
          entries: [row("ready-tail", { projectId: readyProject })],
          nextCursors: {},
        })) as unknown as Parameters<typeof page.mockImplementation>[0]);
      const targets: IssueListTarget[] = [
        { environmentId: readyId, input: { state: "all", limit: 50, projectId: readyProject } },
        { environmentId: peerId, input: { state: "all", limit: 50, projectId: peerProject } },
      ];
      const registry = AtomRegistry.make();
      const releases = targets.map((target) => registry.mount(issueEnvironment.list(target)));
      const root = createRoot(document.createElement("div"));
      let result: ReturnType<typeof useIssueList>;
      let refresh: Promise<void> | undefined;
      function Probe() {
        const current = useIssueList(targets);
        useLayoutEffect(() => {
          result = current;
        });
        return null;
      }
      try {
        yield* Effect.all(
          targets.map((target) => AtomRegistry.getResult(registry, issueEnvironment.list(target))),
        );
        yield* Effect.promise(() =>
          act(async () =>
            root.render(
              createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
            ),
          ),
        );
        const peerQuery = issueEnvironment.list(targets[1]!);
        if (peerState === "connecting") {
          const waiting = Promise.withResolvers<void>();
          const unsubscribe = registry.subscribe(peerQuery, (value) => {
            if (value.waiting) waiting.resolve();
          });
          const releaseAct = Promise.withResolvers<void>();
          const flush = Promise.resolve(act(async () => releaseAct.promise));
          const supervisor = supervisors.get(peerId)!;
          yield* SubscriptionRef.set(supervisor.state, {
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connecting" as const,
          });
          yield* Effect.promise(() => waiting.promise);
          releaseAct.resolve();
          yield* Effect.promise(() => flush);
          unsubscribe();
        } else {
          peerFails = true;
          const failed = Promise.withResolvers<void>();
          const unsubscribe = registry.subscribe(peerQuery, (value) => {
            if (value._tag === "Failure" && !value.waiting) failed.resolve();
          });
          yield* Effect.promise(() =>
            act(async () => {
              registry.refresh(peerQuery);
              await failed.promise;
            }),
          );
          unsubscribe();
          peerFails = false;
        }
        let complete = false;
        const readySettled = Promise.withResolvers<void>();
        const unsubscribe = registry.subscribe(issueEnvironment.list(targets[0]!), (value) => {
          if (!value.waiting && reads.filter((id) => id === readyProject).length === 2)
            readySettled.resolve();
        });
        yield* Effect.promise(() =>
          act(async () => {
            refresh = result!.onRefresh().then(() => {
              complete = true;
            });
            await refreshed.promise;
            await readySettled.promise;
          }),
        );
        unsubscribe();
        expect(complete).toBe(true);
        expect(result!.refreshing).toBe(false);
        if (peerState === "connecting") {
          expect(reads.filter((id) => id === peerProject)).toHaveLength(1);
          const held = result!.lists.find((source) => source.environmentId === peerId)!.held;
          expect(held.entries).toEqual(peer.entries);
          expect(held.nextCursors).toEqual(peer.nextCursors);
          expect(held.errors).toEqual(peer.errors);
          yield* Effect.promise(() => act(async () => result!.loadMore()));
          expect(page).toHaveBeenCalledExactlyOnceWith("issues.list", {
            ...targets[0]!.input,
            cursors: first.nextCursors,
          });
        } else {
          expect(reads.filter((id) => id === peerProject)).toHaveLength(3);
          expect(result!.errors).toEqual([]);
          expect(page).not.toHaveBeenCalled();
        }
        expect(reads.filter((id) => id === readyProject)).toHaveLength(2);
      } finally {
        yield* Effect.promise(() => act(async () => root.unmount()));
        yield* Effect.promise(() => refresh ?? Promise.resolve());
        for (const release of releases) release();
        registry.dispose();
        request.mockRestore();
        page.mockRestore();
      }
    }),
);

effectIt.effect(
  "retries a failed viewer restart after a partial manual refresh before its sibling",
  () =>
    Effect.gen(function* () {
      const current = row("A-first");
      const other = row("other", {
        tracker: IssueTrackerKind.make("github"),
        host: "github.example",
        scope: "group/other",
        projectId: ProjectId.make("other"),
      });
      const first: IssueListResult = {
        entries: [current, other],
        sources: [source(current), source(other)],
        viewers: { "gitlab gitlab.example": "A", "github github.example": "other" },
        trackers: [],
        errors: [],
        nextCursors: { [cursor]: "2", [otherCursor]: "O2" },
      };
      const changed: IssueListResult = {
        ...first,
        entries: [row("other-tail", other)],
        viewers: { ...first.viewers, "gitlab gitlab.example": "B" },
        nextCursors: { [otherCursor]: "O3" },
      };
      const failed: IssueListResult = {
        ...first,
        entries: [other],
        viewers: { "github github.example": "other" },
        errors: [
          {
            projectId: current.projectId,
            projectTitle: current.projectTitle,
            tracker: current.tracker,
            host: current.host,
            message: "restart failed",
          },
        ],
        nextCursors: { [otherCursor]: "O2" },
      };
      const runtime = Atom.runtime(
        Layer.effect(
          EnvironmentRegistry.EnvironmentRegistry,
          Effect.gen(function* () {
            const supervisor = {
              state: yield* SubscriptionRef.make({
                ...AVAILABLE_CONNECTION_STATE,
                phase: "connected" as const,
              }),
              session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
            } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
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
      Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
      let reads = 0;
      const request = vi.spyOn(RpcClient, "request");
      request.mockImplementation((() =>
        Effect.sync(() => (++reads === 1 ? first : failed))) as unknown as Parameters<
        typeof request.mockImplementation
      >[0]);
      const page = vi.spyOn(RpcClient, "requestGuarded");
      const pages: IssueListInput[] = [];
      page.mockImplementation(((_tag: string, input: IssueListInput) => {
        pages.push(input);
        if (pages.length === 1) return Effect.succeed(changed);
        if (pages.length === 2) return Effect.fail(new Error("restart failed"));
        return Effect.succeed({
          ...first,
          entries: input.cursors ? [row("other-tail-2", other)] : [row("B-first")],
          sources: [source(input.cursors ? other : current)],
          viewers: input.cursors
            ? { "github github.example": "other" }
            : { "gitlab gitlab.example": "B" },
          nextCursors: {},
        });
      }) as unknown as Parameters<typeof page.mockImplementation>[0]);
      const targets: IssueListTarget[] = [
        {
          environmentId: EnvironmentId.make("restart-refresh"),
          input: { state: "all", involvement: "assigned", limit: 50 },
        },
      ];
      const registry = AtomRegistry.make();
      const query = issueEnvironment.list(targets[0]!);
      const release = registry.mount(query);
      const root = createRoot(document.createElement("div"));
      let result: ReturnType<typeof useIssueList>;
      function Probe() {
        const current = useIssueList(targets);
        useLayoutEffect(() => {
          result = current;
        });
        return null;
      }
      try {
        yield* AtomRegistry.getResult(registry, query);
        yield* Effect.promise(() =>
          act(async () =>
            root.render(
              createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
            ),
          ),
        );
        yield* Effect.promise(() => act(async () => result!.loadMore()));
        expect(result!.loadMoreError).toContain("restart failed");
        yield* Effect.promise(() => act(async () => result!.onRefresh()));
        expect(result!.loadMoreError).toContain("restart failed");
        expect(result!.lists[0]!.held.entries.map((entry) => entry.key)).toEqual([
          "other-tail",
          "other",
        ]);
        expect(result!.lists[0]!.held.nextCursors).toEqual({ [otherCursor]: "O3" });
        expect(reads).toBe(2);
        expect(pages).toHaveLength(2);
        yield* Effect.promise(() => act(async () => result!.loadMore()));
        expect(pages).toHaveLength(2);
        yield* Effect.promise(() => act(async () => result!.loadMore(true)));
        const restart = { ...targets[0]!.input, projectId: current.projectId, host: current.host };
        expect(pages).toEqual([
          { ...targets[0]!.input, cursors: first.nextCursors },
          restart,
          restart,
        ]);
        expect(reads).toBe(2);
        expect(result!.loadMoreError).toBeNull();
        expect(result!.lists[0]!.held.entries.map((entry) => entry.key)).toEqual([
          "other-tail",
          "other",
          "B-first",
        ]);
        expect(result!.lists[0]!.held.nextCursors).toEqual({ [otherCursor]: "O3" });
        expect(result!.lists[0]!.held.errors).toEqual([]);
      } finally {
        yield* Effect.promise(() => act(async () => root.unmount()));
        release();
        registry.dispose();
        request.mockRestore();
        page.mockRestore();
      }
    }),
);

effectIt.effect("keeps an exhausted native list terminal after a first-page refresh", () =>
  Effect.gen(function* () {
    const runtime = Atom.runtime(
      Layer.effect(
        EnvironmentRegistry.EnvironmentRegistry,
        Effect.gen(function* () {
          const supervisor = {
            state: yield* SubscriptionRef.make({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected" as const,
            }),
            session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
          } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
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
    Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
    const rows = Array.from({ length: 75 }, (_, index) =>
      row(String(index + 1), {
        updatedAt: `2026-10-01T00:00:00.${String(999 - index).padStart(3, "0")}Z`,
      }),
    );
    const first: IssueListResult = {
      entries: rows.slice(0, 50),
      sources: [source(rows[0]!)],
      nextCursors: { [cursor]: "2" },
      viewers: { "gitlab gitlab.example": "A" },
      trackers: [],
      errors: [],
    };
    const last = { ...first, entries: rows.slice(50), nextCursors: {} };
    const request = vi.spyOn(RpcClient, "request");
    request.mockImplementation((() => Effect.succeed(first)) as unknown as Parameters<
      typeof request.mockImplementation
    >[0]);
    const page = vi.spyOn(RpcClient, "requestGuarded");
    page.mockImplementation((() => Effect.succeed(last)) as unknown as Parameters<
      typeof page.mockImplementation
    >[0]);
    const targets: IssueListTarget[] = [
      {
        environmentId: EnvironmentId.make("terminal-list"),
        input: { state: "all", involvement: "assigned", limit: 50 },
      },
    ];
    const registry = AtomRegistry.make();
    const query = issueEnvironment.list(targets[0]!);
    const release = registry.mount(query);
    const root = createRoot(document.createElement("div"));
    let result: ReturnType<typeof useIssueList>;
    function Probe() {
      const current = useIssueList(targets);
      useLayoutEffect(() => {
        result = current;
      });
      return null;
    }
    try {
      yield* AtomRegistry.getResult(registry, query);
      yield* Effect.promise(() =>
        act(async () =>
          root.render(
            createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
          ),
        ),
      );
      expect(result!.hasMore).toBe(true);
      yield* Effect.promise(() => act(async () => result!.loadMore()));
      expect(result!.lists[0]!.held.entries).toEqual(rows);
      expect(result!.hasMore).toBe(false);
      yield* Effect.promise(() => act(async () => result!.onRefresh()));
      expect(result!.lists[0]!.held.entries).toEqual(rows);
      expect(result!.lists[0]!.held.nextCursors).toEqual({});
      expect(result!.hasMore).toBe(false);
      yield* Effect.promise(() => act(async () => result!.loadMore()));
      expect(request.mock.calls.map(([, input]) => input)).toEqual([
        targets[0]!.input,
        targets[0]!.input,
      ]);
      expect(page).toHaveBeenCalledExactlyOnceWith("issues.list", {
        ...targets[0]!.input,
        cursors: first.nextCursors,
      });
    } finally {
      yield* Effect.promise(() => act(async () => root.unmount()));
      release();
      registry.dispose();
      request.mockRestore();
      page.mockRestore();
    }
  }),
);
