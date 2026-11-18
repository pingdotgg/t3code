// Mounts the page the hostname and query ask for: the board and ChatSlot split, the board-only
// embed for a T3 Code panel, the export view, or a redirect to the chat.
import { StrictMode, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type Layout,
} from "react-resizable-panels";
import { Board, ShowChat } from "./board";
import { ChatSlot } from "./ChatSlot";
import { pageMode, type OpenView } from "./pageMode";
import { startPanelHost } from "./panelHost";
import "./style.css";

declare const __OPEN_VIEWS__: Record<string, OpenView>;

const mode = pageMode({
  hostname: location.hostname,
  search: location.search,
  framed: window.parent !== window,
  openViews: __OPEN_VIEWS__,
});

// Dragging the divider past a panel's minimum collapses that panel. Its button brings it back at that
// minimum width, so the side already on screen changes as little as possible.
const boardMin = 35;
const chatMin = 20;
const group = createRef<GroupImperativeHandle>();
const startLayout = (start: "board" | "chat" | "remembered"): Layout | undefined => {
  if (start === "board") return { board: 100, chat: 0 };
  if (start === "chat") return { board: 0, chat: 100 };
  return (JSON.parse(localStorage.getItem("wb-layout") ?? "null") as { layout: Layout } | null)
    ?.layout;
};
const showChat = () => group.current?.setLayout({ board: 100 - chatMin, chat: chatMin });
const showBoard = () => group.current?.setLayout({ board: boardMin, chat: 100 - boardMin });

function SplitPage({ start }: { start: "board" | "chat" | "remembered" }) {
  const [hidden, setHidden] = useState<"board" | "chat" | null>(null);
  const [defaultLayout] = useState(() => startLayout(start));
  return (
    <main>
      <Group
        orientation="horizontal"
        groupRef={group}
        defaultLayout={defaultLayout}
        onLayoutChange={(layout) =>
          setHidden(layout.board === 0 ? "board" : layout.chat === 0 ? "chat" : null)
        }
        onLayoutChanged={(layout) => localStorage.setItem("wb-layout", JSON.stringify({ layout }))}
      >
        <Panel id="board" defaultSize="68%" minSize={`${boardMin}%`} collapsible>
          <ShowChat value={hidden === "chat" ? showChat : null}>
            <Board />
          </ShowChat>
        </Panel>
        <Separator className={hidden ? "divider collapsed" : "divider"} />
        <Panel id="chat" defaultSize="32%" minSize={`${chatMin}%`} collapsible>
          <ChatSlot boardHidden={hidden === "board"} showBoard={showBoard} />
        </Panel>
      </Group>
    </main>
  );
}

function page() {
  switch (mode.kind) {
    case "export":
      return (
        <main>
          <Board exportMode />
        </main>
      );
    case "embed":
      startPanelHost();
      return (
        <StrictMode>
          <main>
            <Board />
          </main>
        </StrictMode>
      );
    case "redirect":
      // The Vite server already answers bare / with a redirect; this covers a cached page.
      location.replace(mode.to);
      return null;
    case "split":
      return (
        <StrictMode>
          <SplitPage start={mode.start} />
        </StrictMode>
      );
  }
}

createRoot(document.getElementById("root")!).render(page());
