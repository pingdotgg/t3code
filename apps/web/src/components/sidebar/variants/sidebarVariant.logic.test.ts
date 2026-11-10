import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { createEnvironmentThreadShellAtoms } from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type SidebarVariant } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarLayout } from "./sidebarLayout";
import {
  arrangeDetailedFolder,
  arrangeStableRows,
  detailedFolderShows,
  rowAttention,
  threadsWaitingOnYou,
  waitingOnYouCountAtom,
  variantRowStyle,
  workerSummary,
  workersByParent,
} from "./sidebarVariant.logic";

const shell = (
  id: string,
  createdAt: string,
  overrides: Record<string, unknown> = {},
): EnvironmentThreadShell =>
  ({
    id,
    environmentId: "environment-a",
    projectId: "project-a",
    createdAt,
    archivedAt: null,
    pinnedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingGuestMessageCount: 0,
    runtime: null,
    lineage: { parentThreadId: null, relationshipToParent: null },
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const worker = (id: string, parent: string, overrides: Record<string, unknown> = {}) =>
  shell(id, "2026-01-01T00:00:00.000Z", {
    lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
    ...overrides,
  });

const arrange = (input: Partial<Parameters<typeof arrangeDetailedFolder>[0]>) =>
  arrangeDetailedFolder({
    collapsed: false,
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
    workers: new Map(),
    workerFold: new Map(),
    parkedOpen: false,
    routeRowKey: null,
    routeThreadKey: null,
    ...input,
  });

const ids = (result: ReturnType<typeof arrange>) =>
  result.items.flatMap((item): string[] =>
    item.kind === "thread" ? [item.thread.id] : [item.kind],
  );

describe("resolveSidebarLayout", () => {
  const variants: readonly SidebarVariant[] = ["default", "detailed", "slim"];
  const flags = [false, true];

  it("gives every combination of the sidebar settings one consistent layout", () => {
    for (const sidebarVariant of variants) {
      for (const boringSidebarEnabled of flags) {
        for (const boringSidebarMultilineRows of flags) {
          for (const sidebarWorkingShelfEnabled of flags) {
            const layout = resolveSidebarLayout({
              sidebarVariant,
              boringSidebarEnabled,
              boringSidebarMultilineRows,
              sidebarWorkingShelfEnabled,
            });
            expect(layout.locked).toBe(sidebarVariant !== "default");
            expect(layout.folders).toBe(sidebarVariant !== "default" || boringSidebarEnabled);
            expect(layout.workingSection).toBe(
              sidebarVariant === "default" && !boringSidebarEnabled && sidebarWorkingShelfEnabled,
            );
            expect(layout.twoLineRows).toBe(
              sidebarVariant === "default"
                ? boringSidebarMultilineRows
                : sidebarVariant === "detailed",
            );
            expect(layout.folders && layout.workingSection).toBe(false);
          }
        }
      }
    }
  });

  it("matches what users have today when nothing is set", () => {
    expect(resolveSidebarLayout(DEFAULT_CLIENT_SETTINGS)).toEqual({
      locked: false,
      folders: false,
      workingSection: true,
      twoLineRows: false,
    });
  });
});

describe("variantRowStyle", () => {
  it("leaves every row to T3 under Default", () => {
    for (const section of ["pinned", "active", "working", "snoozed", "settled"] as const) {
      expect(variantRowStyle("default", section, true)).toBeNull();
      expect(variantRowStyle("default", section, false)).toBeNull();
    }
  });

  it("styles pinned rows in Slim and leaves its shelves to T3", () => {
    expect(variantRowStyle("slim", "active", true)).toBe("folder-slim");
    expect(variantRowStyle("slim", "pinned", false)).toBe("folder-slim");
    expect(variantRowStyle("slim", "settled", false)).toBeNull();
    expect(variantRowStyle("detailed", "settled", true)).toBe("folder-detailed");
  });
});

describe("detailedFolderShows", () => {
  it("keeps an empty folder only when the sidebar's predicate does", () => {
    expect(detailedFolderShows({ active: [], settled: [] }, true)).toBe(true);
    expect(detailedFolderShows({ active: [], settled: [] }, false)).toBe(false);
    expect(detailedFolderShows({ active: [], settled: ["thread"] }, false)).toBe(true);
  });
});

describe("rowAttention", () => {
  it("marks asks, failures and unseen finishes only", () => {
    expect(rowAttention("approval", false)).toBe("warning");
    expect(rowAttention("limited", false)).toBe("warning");
    expect(rowAttention("input", false)).toBe("input");
    expect(rowAttention("request", false)).toBe("guest");
    expect(rowAttention("failed", true)).toBe("error");
    expect(rowAttention("ready", true)).toBe("success");
    expect(rowAttention("ready", false)).toBeUndefined();
    expect(rowAttention("working", true)).toBeUndefined();
  });
});

describe("placement", () => {
  it("keeps every row in its slot when only its state changes", () => {
    const before = [
      shell("a", "2026-01-01T00:00:00.000Z"),
      shell("b", "2026-01-03T00:00:00.000Z", { hasPendingApprovals: true }),
      shell("c", "2026-01-02T00:00:00.000Z"),
    ];
    const after = before.map((thread) =>
      shell(thread.id, thread.createdAt, {
        hasPendingUserInput: true,
        runtime: { status: "idle" },
      }),
    );
    expect(arrangeStableRows(after).map((thread) => thread.id)).toEqual(
      arrangeStableRows(before).map((thread) => thread.id),
    );
    expect(arrangeStableRows(before).map((thread) => thread.id)).toEqual(["b", "c", "a"]);
  });

  it("puts pinned threads first, newest first inside each part", () => {
    const threads = [
      shell("old", "2026-01-01T00:00:00.000Z"),
      shell("new", "2026-01-05T00:00:00.000Z"),
      shell("pin", "2026-01-02T00:00:00.000Z", { pinnedAt: "2026-01-09T00:00:00.000Z" }),
    ];
    expect(arrangeStableRows(threads).map((thread) => thread.id)).toEqual(["pin", "new", "old"]);
  });

  it("parks snoozed and settled threads behind one row in their folder", () => {
    const settled = [shell("s1", "2026-01-01T00:00:00.000Z")];
    const snoozed = [shell("z1", "2026-01-01T00:00:00.000Z")];
    const closed = arrange({ snoozed, settled });
    expect(ids(closed)).toEqual(["parked"]);
    expect(closed.items[0]).toMatchObject({ label: "1 snoozed · 1 settled", open: false });
    expect(ids(arrange({ snoozed, settled, parkedOpen: true }))).toEqual(["parked", "z1", "s1"]);
  });

  it("still shows the open thread in a closed folder or parked group", () => {
    const active = [shell("a", "2026-01-01T00:00:00.000Z"), shell("b", "2026-01-02T00:00:00.000Z")];
    const key = "environment-a:a";
    const closed = arrange({ active, collapsed: true, routeRowKey: key });
    expect(ids(closed)).toEqual(["a"]);
    expect(closed.hiddenThreads.map((thread) => thread.id)).toEqual(["b"]);
    const settled = [shell("s", "2026-01-01T00:00:00.000Z")];
    expect(ids(arrange({ settled, routeRowKey: "environment-a:s" }))).toEqual(["parked", "s"]);
  });
});

describe("workers", () => {
  const parent = shell("p", "2026-01-01T00:00:00.000Z");
  const quiet = worker("w1", "p");
  const asking = worker("w2", "p", { hasPendingApprovals: true });

  it("folds workers until one needs the user, and honors a manual choice", () => {
    const folded = workersByParent([parent, quiet]);
    const closed = arrange({ active: [parent], workers: folded });
    expect(ids(closed)).toEqual(["p"]);
    expect(closed.items[0]).toMatchObject({ workersOpen: false });
    const needs = workersByParent([parent, quiet, asking]);
    const open = arrange({ active: [parent], workers: needs });
    expect(ids(open)).toEqual(["p", "w1", "w2"]);
    expect(open.items[0]).toMatchObject({ workersOpen: true });
    expect(open.items[1]).toMatchObject({ nested: true, lastNested: false });
    expect(open.items[2]).toMatchObject({ nested: true, lastNested: true });
    expect(
      ids(
        arrange({
          active: [parent],
          workers: needs,
          workerFold: new Map([["environment-a:p", false]]),
        }),
      ),
    ).toEqual(["p"]);
  });

  it("shows an open worker under its parent while the row is folded", () => {
    const workers = workersByParent([parent, quiet]);
    expect(ids(arrange({ active: [parent], workers, routeThreadKey: "environment-a:w1" }))).toEqual(
      ["p", "w1"],
    );
  });

  it("counts workers and how many share the most urgent state", () => {
    const running = worker("w3", "p", { runtime: { status: "running" } });
    expect(workerSummary([quiet])).toBe("1 worker");
    expect(workerSummary([quiet, running])).toBe("2 workers · 1 working");
    expect(workerSummary([running, asking, quiet])).toBe("3 workers · 1 approval");
  });

  it("counts a thread as waiting only when it asks itself", () => {
    const raised = shell("r", "2026-01-01T00:00:00.000Z", { pendingSubagentRequest: "approval" });
    const archived = shell("x", "2026-01-01T00:00:00.000Z", {
      hasPendingApprovals: true,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const other = shell("o", "2026-01-01T00:00:00.000Z", {
      hasPendingUserInput: true,
      projectId: "project-b",
    });
    const threads = [raised, archived, asking, other];
    expect(threadsWaitingOnYou(threads, null).map((thread) => thread.id)).toEqual(["w2", "o"]);
    expect(
      threadsWaitingOnYou(threads, new Set(["environment-a:project-a"])).map((thread) => thread.id),
    ).toEqual(["w2"]);
  });
});

describe("waitingOnYouCountAtom", () => {
  const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
  const projectId = ProjectId.make("project-a");
  const here = EnvironmentId.make("environment-a");
  const there = EnvironmentId.make("environment-b");
  const approval = {
    id: RuntimeRequestId.make("request-a"),
    kind: "command" as const,
    createdAt: now,
  };
  const wire = (
    id: string,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ): OrchestrationV2ThreadShell => ({
    id: ThreadId.make(id),
    projectId,
    title: id,
    providerInstanceId: "codex" as OrchestrationV2ThreadShell["providerInstanceId"],
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5.4",
    } as OrchestrationV2ThreadShell["modelSelection"],
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  });
  const asking = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
    wire(id, { pendingRuntimeRequest: approval, ...overrides });
  const worker = (id: string, parent: string) =>
    asking(id, {
      lineage: {
        rootThreadId: ThreadId.make(parent),
        parentThreadId: ThreadId.make(parent),
        relationshipToParent: "subagent",
      },
    });

  function count(
    threads: Record<string, OrchestrationV2ThreadShell[]>,
    options: { hiddenTags?: ReadonlyArray<string>; disabled?: EnvironmentId } = {},
  ) {
    const ids = Object.keys(threads).map((id) => EnvironmentId.make(id));
    const catalogValueAtom = Atom.make({
      isReady: true,
      entries: new Map(
        ids.map((id) => [
          id,
          {
            target: new PrimaryConnectionTarget({
              environmentId: id,
              label: "Environment",
              httpBaseUrl: "https://example.test",
              wsBaseUrl: "wss://example.test",
            }),
            profile: Option.none(),
            enabled: id !== options.disabled,
          },
        ]),
      ),
    });
    const shells = createEnvironmentThreadShellAtoms({
      catalogValueAtom,
      snapshotAtom: (id) =>
        Atom.make<OrchestrationV2ShellSnapshot | null>({
          schemaVersion: 1,
          snapshotSequence: 0,
          projects: [],
          threads: threads[id] ?? [],
          archivedThreads: [],
        }),
      hiddenThreadTagsAtom: () => Atom.make(options.hiddenTags ?? null),
    });
    const registry = AtomRegistry.make();
    const value = registry.get(waitingOnYouCountAtom(shells));
    registry.dispose();
    return value;
  }

  it("counts each thread asking you, workers on their own", () => {
    expect(
      count({
        [here]: [wire("parent"), worker("worker-a", "parent"), worker("worker-b", "parent")],
      }),
    ).toBe(2);
  });

  it("leaves out a thread the tag filter hides", () => {
    expect(
      count(
        { [here]: [asking("shown"), asking("hidden", { tags: ["later"] })] },
        { hiddenTags: ["later"] },
      ),
    ).toBe(1);
  });

  it("leaves out an archived thread", () => {
    expect(count({ [here]: [asking("open"), asking("archived", { archivedAt: now })] })).toBe(1);
  });

  it("leaves out a switched off environment", () => {
    expect(count({ [here]: [asking("a")], [there]: [asking("b")] }, { disabled: there })).toBe(1);
  });
});
