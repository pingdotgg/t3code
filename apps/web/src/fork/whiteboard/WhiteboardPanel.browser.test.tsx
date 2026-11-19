import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";
import { postWhiteboardHover, showBoardRef } from "./boardChannel";
import { WhiteboardPanel } from "./WhiteboardPanel";

const role = vi.hoisted(() => ({ projectRoot: "/project" }));

vi.mock("./role", () => ({
  useBoardHostRole: () => ({ menu: {} }),
  isBoardHost: () => true,
  isTopWindow: () => true,
  boardOfferedFor: () => true,
  useBoardOfferedFor: () => true,
  readThreadProjectRoot: () => role.projectRoot,
  useThreadProjectRoot: () => role.projectRoot,
}));

type BoardWindow = Window & { kept?: boolean; received?: unknown[] };

// Each test has its own thread and project, so boards a test leaves loaded never meet another test.
function setup(name: string) {
  role.projectRoot = `/project-${name}`;
  const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(`thread-${name}`));
  useRightPanelStore.getState().open(threadRef, "whiteboard");
  return threadRef;
}

function Panes(props: {
  readonly at: "left" | "right" | null;
  readonly threadRef: ReturnType<typeof setup>;
  readonly sheet?: boolean;
}) {
  const pane = (side: "left" | "right") => (
    <div data-pane={side} style={{ position: "relative", display: "flex", width: 400 }}>
      {props.at === side ? <WhiteboardPanel threadRef={props.threadRef} /> : null}
    </div>
  );
  return (
    <div
      data-slot={props.sheet ? "sheet-popup" : undefined}
      style={{ display: "flex", height: 300 }}
    >
      {pane("left")}
      {pane("right")}
    </div>
  );
}

const shownFrame = (container: HTMLElement) =>
  container.querySelector<HTMLIFrameElement>('iframe[title="Whiteboard"]');

// The board page's own `wb-ready`, posted from inside the frame so the frame is its source.
async function loadedBoard(container: HTMLElement): Promise<BoardWindow> {
  const board = await vi.waitFor(() => {
    const window = shownFrame(container)?.contentWindow as BoardWindow | null | undefined;
    expect(window?.location.search).toContain("embed=panel");
    expect(window?.document.readyState).toBe("complete");
    return window!;
  });
  board.kept = true;
  board.received = [];
  board.addEventListener("message", (event) => board.received!.push(event.data));
  (board as Window & { eval: (code: string) => void }).eval(
    'parent.postMessage({ type: "wb-ready" }, location.origin)',
  );
  return board;
}

// Hover with no reference only clears a mark, which is harmless at any time.
const isNotAHoverEnd = (message: unknown) => {
  const { type, ref } = message as { type?: unknown; ref?: unknown };
  return type !== "wb-hover" || ref !== null;
};

function closeWhiteboardTab(threadRef: ReturnType<typeof setup>) {
  const surfaces = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.surfaces;
  for (const surface of surfaces ?? [])
    if (surface.kind === "whiteboard")
      useRightPanelStore.getState().closeSurface(threadRef, surface.id);
}

describe("WhiteboardPanel", () => {
  it("keeps its board page loaded while hidden and when it moves to the other pane", async () => {
    const threadRef = setup("keep");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    const board = await loadedBoard(screen.container);

    for (const at of [null, "left", null, "right", "left"] as const) {
      await screen.rerender(<Panes at={at} threadRef={threadRef} />);
      if (at === null) continue;
      expect(shownFrame(screen.container)?.closest("[data-pane]")?.getAttribute("data-pane")).toBe(
        at,
      );
      expect((shownFrame(screen.container)?.contentWindow as BoardWindow | null)?.kept).toBe(true);
    }
    expect(shownFrame(screen.container)?.contentWindow).toBe(board);
    closeWhiteboardTab(threadRef);
  });

  it("highlights a link clicked while hidden in the loaded board, once, and pauses it while hidden", async () => {
    const threadRef = setup("link");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    const board = await loadedBoard(screen.container);
    await screen.rerender(<Panes at={null} threadRef={threadRef} />);

    postWhiteboardHover("board://r/1,2,3,4", document.createElement("a"));
    showBoardRef("board://r/5,6,7,8", threadRef);
    await screen.rerender(<Panes at="left" threadRef={threadRef} />);

    await vi.waitFor(() =>
      expect(board.received).toContainEqual({ type: "wb-highlight", ref: "board://r/5,6,7,8" }),
    );
    expect(shownFrame(screen.container)?.contentWindow).toBe(board);
    expect(board.received!.filter(isNotAHoverEnd)).toEqual([
      { type: "wb-visible", visible: false },
      { type: "wb-visible", visible: true },
      { type: "wb-highlight", ref: "board://r/5,6,7,8" },
    ]);
    closeWhiteboardTab(threadRef);
  });

  it("keeps a click that opened the board while it moves to the other pane before it is ready", async () => {
    const threadRef = setup("move");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    showBoardRef("board://r/5,6,7,8", threadRef);
    await screen.rerender(<Panes at="right" threadRef={threadRef} />);

    const board = await loadedBoard(screen.container);
    await vi.waitFor(() =>
      expect(board.received).toEqual([{ type: "wb-highlight", ref: "board://r/5,6,7,8" }]),
    );
    closeWhiteboardTab(threadRef);
  });

  it.each([
    [
      "closes",
      "close",
      (ref: ReturnType<typeof setup>) => useRightPanelStore.getState().close(ref),
    ],
    [
      "maximizes",
      "maximize",
      (ref: ReturnType<typeof setup>) => useRightPanelStore.getState().setMaximized(ref, true),
    ],
  ] as const)(
    "keeps its board page loaded when its sheet %s and its portal node leaves first",
    async (_, name, sheetGoes) => {
      const threadRef = setup(name);
      await using screen = await render(<Panes at="left" threadRef={threadRef} sheet />, {
        router: false,
      });
      const board = await loadedBoard(screen.container);
      sheetGoes(threadRef);
      // The sheet's portal node leaves the document before React detaches the refs inside it.
      screen.container.remove();
      await screen.unmount();

      useRightPanelStore.getState().open(threadRef, "whiteboard");
      await using reopened = await render(<Panes at="left" threadRef={threadRef} />, {
        router: false,
      });
      expect(shownFrame(reopened.container)?.contentWindow).toBe(board);
      expect(board.kept).toBe(true);
      closeWhiteboardTab(threadRef);
    },
  );

  it("shows its board again when its sheet reopens before it is removed", async () => {
    const threadRef = setup("reopen");
    await using screen = await render(<Panes at="left" threadRef={threadRef} sheet />, {
      router: false,
    });
    const board = await loadedBoard(screen.container);
    useRightPanelStore.getState().close(threadRef);
    expect(shownFrame(screen.container)).toBeNull();
    useRightPanelStore.getState().open(threadRef, "whiteboard");
    expect(shownFrame(screen.container)?.contentWindow).toBe(board);
    closeWhiteboardTab(threadRef);
  });

  it("leaves its board unloaded when the sheet opens again after its last tab closed", async () => {
    const threadRef = setup("evicted");
    await using screen = await render(<Panes at="left" threadRef={threadRef} sheet />, {
      router: false,
    });
    const frame = shownFrame(screen.container)!;
    await loadedBoard(screen.container);
    closeWhiteboardTab(threadRef);
    useRightPanelStore.getState().toggleVisibility(threadRef);
    expect(frame.isConnected).toBe(false);
  });

  it("holds a link for a board page that reloads until that page is ready again", async () => {
    const threadRef = setup("reload");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    const board = await loadedBoard(screen.container);
    await expect.element(screen.getByText("Loading board...")).not.toBeInTheDocument();
    (board as Window & { eval: (code: string) => void }).eval(
      'parent.postMessage({ type: "wb-unload" }, location.origin)',
    );
    await expect.element(screen.getByText("Loading board...")).toBeInTheDocument();
    showBoardRef("board://r/5,6,7,8", threadRef);
    // Messages from one window arrive in order, so a highlight sent now would arrive before this.
    board.postMessage({ type: "probe" }, location.origin);
    await vi.waitFor(() => expect(board.received).toContainEqual({ type: "probe" }));
    expect(board.received!.filter(isNotAHoverEnd)).toEqual([{ type: "probe" }]);
    board.received = [];

    (board as Window & { eval: (code: string) => void }).eval(
      'parent.postMessage({ type: "wb-ready" }, location.origin)',
    );
    await vi.waitFor(() =>
      expect(board.received).toEqual([{ type: "wb-highlight", ref: "board://r/5,6,7,8" }]),
    );
    closeWhiteboardTab(threadRef);
  });

  it("unloads its board when the Whiteboard tab closes", async () => {
    const threadRef = setup("close");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    const frame = shownFrame(screen.container)!;
    await loadedBoard(screen.container);
    await screen.rerender(<Panes at={null} threadRef={threadRef} />);

    closeWhiteboardTab(threadRef);
    expect(frame.isConnected).toBe(false);
  });
});
