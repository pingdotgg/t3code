// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  eraseHeldText,
  holdTextForUrlRouteTarget,
  isUrlTargetSidebarTextKey,
  setUrlRouteTargetKey,
  insertHeldText,
} from "./components/keptView";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveActiveThreadRouteRef,
  finishWarmingThreadView,
  keepReleasedThreadView,
  resolveKeptThreadViews,
  resolveThreadRouteRenderState,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  type KeptThreadView,
} from "./threadRoutes";

describe("sidebar typing during a kept thread navigation", () => {
  const takeHeldText = (key: string) => {
    let taken: string | null = null;
    insertHeldText(key, (text) => {
      taken = text;
      return true;
    });
    return taken;
  };
  const previous = "server:env-1:previous";
  const destination = "server:env-1:destination";
  const item = document.createElement("li");
  item.setAttribute("data-thread-item", "env-1:destination");
  item.innerHTML =
    '<div data-testid="sidebar-row-slim" role="button" tabindex="0"><button>Menu</button></div>';
  const row = item.querySelector<HTMLElement>("[role=button]")!;

  afterEach(() => {
    takeHeldText(destination);
    setUrlRouteTargetKey(null);
    vi.restoreAllMocks();
  });

  it("keeps destination text until its composer accepts it, even after a long connection", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    setUrlRouteTargetKey(destination);
    holdTextForUrlRouteTarget(previous, "draft");
    const insert = vi.fn().mockReturnValue(false);
    insertHeldText(destination, insert);
    clock.mockReturnValue(5_000);
    insertHeldText(destination, insert);
    expect(insert.mock.calls).toEqual([["draft"], ["draft"]]);
    expect(takeHeldText(previous)).toBeNull();
    insert.mockReturnValue(true);
    insertHeldText(destination, insert);
    expect(takeHeldText(destination)).toBeNull();
    expect(insert).toHaveBeenCalledTimes(3);
  });

  it("holds destination row typing without giving any text to the previous draft", () => {
    setUrlRouteTargetKey(destination);
    const key = new KeyboardEvent("keydown", { key: "A", shiftKey: true });
    row.dispatchEvent(key);
    expect(isUrlTargetSidebarTextKey(key)).toBe(true);
    expect(holdTextForUrlRouteTarget(previous, key.key)).toBe(true);
    expect(takeHeldText(previous)).toBeNull();
    holdTextForUrlRouteTarget(previous, "b");
    expect(eraseHeldText(previous)).toBe(true);
    holdTextForUrlRouteTarget(previous, "c");
    expect(takeHeldText(destination)).toBe("Ac");
    expect(takeHeldText(destination)).toBeNull();
    setUrlRouteTargetKey(previous);
    expect(isUrlTargetSidebarTextKey(key)).toBe(false);
    setUrlRouteTargetKey(destination);
    expect(holdTextForUrlRouteTarget(destination, "a")).toBe(false);
    row.querySelector("button")!.dispatchEvent(key);
    expect(isUrlTargetSidebarTextKey(key)).toBe(false);
    expect(takeHeldText(destination)).toBeNull();
  });

  it.each([
    { key: " " },
    { key: "Enter" },
    { key: "Tab" },
    { key: "ArrowDown" },
    { key: "a", ctrlKey: true },
    { key: "a", metaKey: true },
    { key: "a", altKey: true },
    { key: "a", isComposing: true },
  ])("leaves activation, navigation, modifiers and composition alone: %j", (init) => {
    setUrlRouteTargetKey(destination);
    const key = new KeyboardEvent("keydown", init);
    row.dispatchEvent(key);
    expect(isUrlTargetSidebarTextKey(key)).toBe(false);
    expect(takeHeldText(destination)).toBeNull();
  });
});

describe("threadRoutes", () => {
  it("does not treat cached thread lists as authoritative for deep links", () => {
    expect(isThreadRouteSnapshotAuthoritative("empty")).toBe(false);
    expect(isThreadRouteSnapshotAuthoritative("cached")).toBe(false);
    expect(isThreadRouteSnapshotAuthoritative("synchronizing")).toBe(false);
    expect(isThreadRouteSnapshotAuthoritative("live")).toBe(true);
  });

  it("builds canonical thread route params from a scoped ref", () => {
    const ref = scopeThreadRef("env-1" as never, ThreadId.make("thread-1"));

    expect(buildThreadRouteParams(ref)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("resolves a scoped ref only when both params are present", () => {
    expect(
      resolveThreadRouteRef({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(resolveThreadRouteRef({ environmentId: "env-1" })).toBeNull();
    expect(resolveThreadRouteRef({ threadId: "thread-1" })).toBeNull();
  });

  it("builds canonical draft route params from a draft id", () => {
    expect(buildDraftThreadRouteParams(DraftId.make("draft-1"))).toEqual({
      draftId: "draft-1",
    });
  });

  it("resolves draft and server route targets", () => {
    expect(
      resolveThreadRouteTarget({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "server",
      threadRef: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
    });

    expect(
      resolveThreadRouteTarget({
        draftId: "draft-1",
      }),
    ).toEqual({
      kind: "draft",
      draftId: "draft-1",
    });
  });

  it("resolves the backing thread while a draft route is being promoted", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: scopeThreadRef("env-2" as never, ThreadId.make("server-thread")),
      }),
    ).toEqual({
      environmentId: "env-2",
      threadId: "server-thread",
    });
  });

  it("does not treat a draft's reserved thread ref as an active sidebar thread", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: null,
      }),
    ).toBeNull();
  });

  it("renders authoritative server-thread shells when bootstrap is complete", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("ready");
  });

  it("renders server threads and local drafts when they are ready", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("ready");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: true,
      }),
    ).toBe("ready");
  });

  it.each([
    { status: "cached", source: "server thread" },
    { status: "synchronizing", source: "server thread" },
    { status: "cached", source: "draft" },
    { status: "synchronizing", source: "draft" },
  ] as const)(
    "keeps available $source visible while the shell is $status",
    ({ status, source }) => {
      expect(
        resolveThreadRouteRenderState({
          bootstrapComplete: isThreadRouteSnapshotAuthoritative(status),
          serverThreadExists: source === "server thread",
          serverThreadDeleted: false,
          draftThreadExists: source === "draft",
        }),
      ).toBe("ready");
    },
  );

  it("distinguishes bootstrap loading from a missing thread", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: false,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("loading");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("redirects deleted server threads", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: true,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("waits for the live shell before redirecting a deleted thread", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: isThreadRouteSnapshotAuthoritative("cached"),
        serverThreadExists: true,
        serverThreadDeleted: true,
        draftThreadExists: false,
      }),
    ).toBe("loading");
  });
});

describe("resolveKeptThreadViews", () => {
  const serverView = (id: string): Omit<KeptThreadView, "visit"> => ({
    key: `env-1:${id}`,
    threadKey: `env-1:${id}`,
    environmentId: "env-1" as never,
    threadId: ThreadId.make(id),
    draftId: null,
  });
  // Opens each thread in turn, keeping released threads and finishing their
  // warm-up right away, as idle time would.
  const visit = (ids: ReadonlyArray<string>, limit?: number) =>
    ids.reduce<ReadonlyArray<KeptThreadView>>((views, id) => {
      const update = resolveKeptThreadViews(views, serverView(id), limit);
      if (update.released === null) return update.views;
      const kept = keepReleasedThreadView(update.views, update.released, limit);
      const warming = kept.find((view) => view.warming === true);
      return warming === undefined ? kept : finishWarmingThreadView(kept, warming.key);
    }, []);

  it("returns the same list when the shown thread is shown again", () => {
    const views = visit(["a"]);
    expect(resolveKeptThreadViews(views, serverView("a")).views).toBe(views);
  });

  it("opens a new thread in the shown view and releases the thread it showed", () => {
    const first = resolveKeptThreadViews([], serverView("a")).views;
    const update = resolveKeptThreadViews(first, serverView("b"));
    expect(update.views.map((view) => [view.key, view.threadId])).toEqual([
      ["view:env-1:a:1", "b"],
    ]);
    expect(update.released?.threadId).toBe("a");
  });

  it("keeps a released thread in a warming view, then reveals it on a revisit", () => {
    const first = resolveKeptThreadViews([], serverView("a")).views;
    const update = resolveKeptThreadViews(first, serverView("b"));
    const kept = keepReleasedThreadView(update.views, update.released!);
    expect(kept.map((view) => [view.threadId, view.warming === true])).toEqual([
      ["b", false],
      ["a", true],
    ]);
    const revisit = resolveKeptThreadViews(kept, serverView("a"));
    expect(revisit.released).toBeNull();
    expect(revisit.views.map((view) => view.key)).toEqual(kept.map((view) => view.key));
    expect(revisit.views.find((view) => view.threadId === "a")?.warming).toBe(false);
  });

  it("drops the least recently shown hidden view to keep a released thread in a full pool", () => {
    const views = visit(["a", "b", "c"], 3);
    expect(views.map((view) => view.threadId).toSorted()).toEqual(["a", "b", "c"]);
    const next = visit(["a", "b", "c", "d"], 3);
    expect(next.map((view) => view.threadId).toSorted()).toEqual(["b", "c", "d"]);
  });

  it("skips keeping a released thread that is shown again", () => {
    const first = resolveKeptThreadViews([], serverView("a")).views;
    const update = resolveKeptThreadViews(first, serverView("b"));
    const back = resolveKeptThreadViews(update.views, serverView("a"));
    expect(keepReleasedThreadView(back.views, update.released!)).toBe(back.views);
  });

  it("keeps a promoted draft's view, and its key, on the thread route", () => {
    const draftId = DraftId.make("draft-1");
    const draft = resolveKeptThreadViews([], { ...serverView("t"), key: draftId, draftId }).views;
    const promoted = resolveKeptThreadViews(draft, serverView("t")).views;
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ key: draftId, draftId: null, threadId: "t" });
  });

  it("drops a draft's view once another view is shown", () => {
    const draftId = DraftId.make("draft-1");
    const views = resolveKeptThreadViews(visit(["a"]), {
      ...serverView("t"),
      key: draftId,
      draftId,
    }).views;
    expect(
      resolveKeptThreadViews(views, serverView("a")).views.map((view) => view.threadId),
    ).toEqual(["a"]);
  });
});
