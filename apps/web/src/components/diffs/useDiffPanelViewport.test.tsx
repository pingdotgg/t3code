import { CodeView, parseDiffFromFile, type CodeViewScrollTarget } from "@pierre/diffs";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import {
  act,
  StrictMode,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type DiffPanelSelection, useDiffPanelStore } from "../../diffPanelStore";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";
import { useDiffPanelViewport } from "./useDiffPanelViewport";

type ViewportHandle = NonNullable<Parameters<typeof useDiffPanelViewport>[0]>;
const SCOPE = "environment-1:thread-1:unstaged";
const SELECTION: DiffPanelSelection = { kind: "unstaged" };
let currentViewer: ViewerFixture | undefined;
let renderedItemsAvailable = true;

// Model Pierre's public position/scroll API and its cleanup order, not DOM geometry.
class ViewerFixture {
  mounted = false;
  scrollTop = 0;
  targets: CodeViewScrollTarget[] = [];
  pendingTarget: CodeViewScrollTarget | undefined;
  items = [
    { id: "first", top: 0 },
    { id: "external", top: 200 },
    { id: "tree", top: 800 },
    { id: "anchor", top: 1132 },
  ];

  constructor(readonly onScroll: (scrollTop: number, viewer: ViewerFixture) => void) {}

  getRenderedItems() {
    return renderedItemsAvailable ? this.items : [];
  }

  getTopForItem(id: string) {
    return this.items.find((item) => item.id === id)?.top;
  }

  userScroll(position: number) {
    this.scrollTop = position;
    this.onScroll(position, this);
  }

  scrollTo(target: CodeViewScrollTarget) {
    if (!this.mounted) throw new Error("Cannot scroll an unmounted viewer");
    this.targets.push(target);
    if (!renderedItemsAvailable) {
      this.pendingTarget = target;
      return;
    }
    this.applyTarget(target);
  }

  finishRendering() {
    renderedItemsAvailable = true;
    if (this.pendingTarget) this.applyTarget(this.pendingTarget);
    this.pendingTarget = undefined;
  }

  private applyTarget(target: CodeViewScrollTarget) {
    // Pierre's position target subtracts the sticky header; item targets do not.
    if (target.type === "position") this.userScroll(Math.max(0, target.position - 32));
    if (target.type === "item") {
      const top = this.getTopForItem(target.id);
      if (top === undefined) throw new Error("Cannot reveal a missing item");
      this.userScroll(Math.max(0, top - (target.offset ?? 0)));
    }
  }
}

function Viewer({
  viewerRef,
  onScroll,
}: {
  viewerRef: Ref<ViewportHandle>;
  onScroll: ReturnType<typeof useDiffPanelViewport>;
}) {
  const instance = useRef<ViewerFixture | undefined>(undefined);
  useLayoutEffect(() => {
    const fixture = new ViewerFixture(onScroll);
    instance.current = fixture;
    fixture.mounted = true;
    currentViewer = fixture;
    return () => {
      fixture.mounted = false;
      fixture.scrollTop = 0;
      instance.current = undefined;
      if (currentViewer === fixture) currentViewer = undefined;
    };
  }, [onScroll]);
  useImperativeHandle(
    viewerRef,
    () => ({
      getInstance: () => instance.current,
      scrollTo: (target) => {
        if (!instance.current) throw new Error("Cannot scroll an unmounted viewer");
        instance.current.scrollTo(target);
      },
    }),
    [],
  );
  return null;
}

function Panel({
  scope = SCOPE,
  selection = SELECTION,
  fileKey = null,
  firstFileKey = "first",
  ready = true,
  revision = 0,
}: {
  scope?: string;
  selection?: DiffPanelSelection;
  fileKey?: string | null;
  firstFileKey?: string | null;
  ready?: boolean;
  revision?: number;
}) {
  const [viewer, setViewer] = useState<ViewportHandle | null>(null);
  const onScroll = useDiffPanelViewport(viewer, scope, selection, fileKey, firstFileKey);
  const reveal = useCodeViewFileReveal(viewer, selection);
  return (
    <>
      {ready && <Viewer key={`${scope}:${revision}`} viewerRef={setViewer} onScroll={onScroll} />}
      <button onClick={() => reveal("tree")}>Reveal tree file</button>
    </>
  );
}

describe("diff panel viewport lifecycle", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    renderedItemsAvailable = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      collapsedFileKeysByScopeKey: {},
      viewportByScopeKey: {},
    });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    currentViewer = undefined;
    vi.unstubAllGlobals();
  });

  it("captures before viewer cleanup and restores a tab remount without per-scroll writes", async () => {
    await act(async () => {
      renderer = create(
        <StrictMode>
          <Panel />
        </StrictMode>,
      );
    });
    const original = currentViewer!;
    const writes = vi.fn();
    const unsubscribe = useDiffPanelStore.subscribe(writes);
    original.userScroll(700);
    original.userScroll(1300);
    expect(writes).not.toHaveBeenCalled();
    unsubscribe();

    await act(async () => renderer!.update(<></>));
    expect(original.mounted).toBe(false);
    expect(original.scrollTop).toBe(0);
    expect(useDiffPanelStore.getState().viewportByScopeKey[SCOPE]?.scrollTop).toBe(1300);
    expect(useDiffPanelStore.getState().viewportByScopeKey[SCOPE]?.fileAnchor).toEqual({
      fileKey: "anchor",
      offset: -168,
    });
    await act(async () => renderer!.update(<Panel />));
    expect(currentViewer).not.toBe(original);
    expect(currentViewer!.scrollTop).toBe(1300);

    currentViewer!.userScroll(0);
    await act(async () => renderer!.update(<></>));
    await act(async () => renderer!.update(<Panel />));
    expect(currentViewer!.scrollTop).toBe(0);
  });

  it("keeps scopes separate and restores only when that scope has a mounted viewer", async () => {
    await act(async () => {
      renderer = create(<Panel />);
    });
    currentViewer!.userScroll(1300);
    await act(async () => renderer!.update(<Panel scope="environment-2:thread-1:unstaged" />));
    expect(currentViewer!.scrollTop).toBe(0);
    currentViewer!.userScroll(400);
    await act(async () => renderer!.update(<Panel ready={false} />));
    expect(currentViewer).toBeUndefined();
    await act(async () => renderer!.update(<Panel />));
    expect(currentViewer!.scrollTop).toBe(1300);
    await act(async () => renderer!.update(<Panel scope="environment-2:thread-1:unstaged" />));
    expect(currentViewer!.scrollTop).toBe(400);
  });

  it("restores an inner viewer replacement and does not replay restoration on rerenders", async () => {
    await act(async () => {
      renderer = create(<Panel />);
    });
    currentViewer!.userScroll(1300);
    await act(async () => renderer!.update(<Panel revision={1} />));
    expect(currentViewer!.scrollTop).toBe(1300);
    currentViewer!.targets.length = 0;
    currentViewer!.userScroll(900);
    await act(async () => renderer!.update(<Panel revision={1} />));
    expect(currentViewer!.targets).toEqual([]);
    expect(currentViewer!.scrollTop).toBe(900);
  });

  it("preserves scrolling after a handled reveal but honors a new same-number request", async () => {
    const selection: DiffPanelSelection = {
      kind: "turn",
      turnId: TurnId.make("turn-1"),
      filePath: "external.ts",
      revealRequestId: 1,
    };
    await act(async () => {
      renderer = create(<Panel selection={selection} fileKey="external" />);
    });
    expect(currentViewer!.scrollTop).toBe(200);
    currentViewer!.userScroll(1300);
    await act(async () => renderer!.update(<></>));
    await act(async () => renderer!.update(<Panel selection={selection} fileKey="external" />));
    expect(currentViewer!.scrollTop).toBe(1300);
    expect(currentViewer!.targets).toEqual([
      { type: "item", id: "anchor", offset: -168, align: "start", behavior: "instant" },
    ]);
    await act(async () => renderer!.update(<></>));
    await act(async () =>
      renderer!.update(<Panel selection={{ ...selection }} fileKey="external" />),
    );
    expect(currentViewer!.scrollTop).toBe(200);
    expect(currentViewer!.targets).toEqual([{ type: "item", id: "external", align: "start" }]);
  });

  it("lets a new tree reveal override restoration and retains its resulting position", async () => {
    useDiffPanelStore.getState().setViewport(SCOPE, { scrollTop: 1300, revealSelection: null });
    await act(async () => {
      renderer = create(<Panel ready={false} />);
    });
    await act(async () => {
      (renderer!.root.findByType("button").props as { onClick(): void }).onClick();
    });
    await act(async () => renderer!.update(<Panel />));
    expect(currentViewer!.targets).toEqual([
      { type: "item", id: "first", offset: -1300, align: "start", behavior: "instant" },
      { type: "item", id: "tree", align: "start" },
    ]);
    expect(currentViewer!.scrollTop).toBe(800);
    await act(async () => renderer!.update(<></>));
    await act(async () => renderer!.update(<Panel />));
    expect(currentViewer!.scrollTop).toBe(800);
  });

  it("falls back to the saved position when the anchored file was removed", async () => {
    await act(async () => {
      renderer = create(<Panel />);
    });
    currentViewer!.items[3] = { id: "removed", top: 1132 };
    currentViewer!.userScroll(1300);
    await act(async () => renderer!.update(<></>));
    await act(async () => renderer!.update(<Panel />));
    expect(currentViewer!.targets).toEqual([
      { type: "item", id: "first", offset: -1300, align: "start", behavior: "instant" },
    ]);
    expect(currentViewer!.scrollTop).toBe(1300);
    await act(async () => renderer!.update(<></>));
    await act(async () => renderer!.update(<Panel />));
    expect(currentViewer!.scrollTop).toBe(1300);
  });

  it.each([0, 1300])(
    "restores saved position %s when the same viewer finishes its delayed first render",
    async (position) => {
      useDiffPanelStore.getState().setViewport(SCOPE, {
        scrollTop: position,
        revealSelection: null,
      });
      renderedItemsAvailable = false;
      await act(async () => {
        renderer = create(<Panel />);
      });
      const original = currentViewer!;
      expect(currentViewer!.scrollTop).toBe(0);
      original.finishRendering();
      await act(async () => renderer!.update(<Panel />));
      expect(currentViewer).toBe(original);
      expect(currentViewer!.scrollTop).toBe(position);
    },
  );

  it("can target registered Pierre items before the first render", () => {
    vi.stubGlobal("document", {
      createElement: () => ({ style: { removeProperty() {} }, remove() {} }),
    });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const viewer = new CodeView({ layout: { paddingTop: 0, paddingBottom: 0, gap: 0 } });
    try {
      viewer.setItems([
        {
          type: "diff",
          id: "first",
          fileDiff: parseDiffFromFile(
            { name: "first.ts", contents: "before\n" },
            { name: "first.ts", contents: "after\n" },
          ),
        },
      ]);
      expect(viewer.getRenderedItems()).toEqual([]);
      expect(viewer.getTopForItem("first")).toBe(0);
    } finally {
      viewer.cleanUp();
    }
  });

  it("waits for a known file without discarding the saved position", async () => {
    useDiffPanelStore.getState().setViewport(SCOPE, {
      scrollTop: 1300,
      revealSelection: null,
    });
    await act(async () => {
      renderer = create(<Panel firstFileKey={null} />);
    });
    const original = currentViewer!;
    expect(original.targets).toEqual([]);
    expect(original.scrollTop).toBe(0);
    await act(async () => renderer!.update(<Panel />));
    expect(currentViewer).toBe(original);
    expect(original.scrollTop).toBe(1300);
  });

  it.each(["thread", "environment"])(
    "does not resurrect a removed %s during unmount",
    async (target) => {
      await act(async () => {
        renderer = create(<Panel />);
      });
      currentViewer!.userScroll(1300);
      const store = useDiffPanelStore.getState();
      const ref = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
      if (target === "thread") store.removeThread(ref);
      else store.removeEnvironment(ref.environmentId);
      await act(async () => renderer!.update(<></>));
      expect(useDiffPanelStore.getState().viewportByScopeKey).toEqual({});
    },
  );
});
