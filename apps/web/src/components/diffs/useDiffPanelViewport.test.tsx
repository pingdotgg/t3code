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

  constructor(readonly onScroll: (scrollTop: number) => void) {}

  userScroll(position: number) {
    this.scrollTop = position;
    this.onScroll(position);
  }

  scrollTo(target: CodeViewScrollTarget) {
    if (!this.mounted) throw new Error("Cannot scroll an unmounted viewer");
    this.targets.push(target);
    if (target.type === "position") this.userScroll(target.position);
    if (target.type === "item") this.userScroll(target.id === "tree" ? 800 : 200);
  }
}

function Viewer({
  viewerRef,
  onScroll,
}: {
  viewerRef: Ref<ViewportHandle>;
  onScroll: (scrollTop: number) => void;
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
      { type: "position", position: 1300, behavior: "instant" },
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
