import type { CodeViewScrollTarget } from "@pierre/diffs";
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

// Model Pierre's public position/scroll API and its cleanup order, not DOM geometry.
class ViewerFixture {
  mounted = false;
  scrollTop = 0;
  targets: CodeViewScrollTarget[] = [];
  items = [
    { id: "first", top: 0 },
    { id: "external", top: 200 },
    { id: "tree", top: 800 },
    { id: "anchor", top: 1132 },
  ];

  constructor(readonly onScroll: (scrollTop: number, viewer: ViewerFixture) => void) {}

  getRenderedItems() {
    return this.items;
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
  ready = true,
  revision = 0,
}: {
  scope?: string;
  selection?: DiffPanelSelection;
  fileKey?: string | null;
  ready?: boolean;
  revision?: number;
}) {
  const [viewer, setViewer] = useState<ViewportHandle | null>(null);
  const onScroll = useDiffPanelViewport(viewer, scope, selection, fileKey);
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
      { type: "position", position: 1300, behavior: "instant" },
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
      { type: "position", position: 1300, behavior: "instant" },
    ]);
    expect(currentViewer!.scrollTop).toBe(1268);
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
