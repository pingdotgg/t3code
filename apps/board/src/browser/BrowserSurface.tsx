import { useAtomValue } from "@effect/atom-react";

import { AddressBar } from "./AddressBar";
import { AgentTabView } from "./AgentTabView";
import { browserAtom } from "./browserTabs";
import { browserHost } from "./host";
import { PageArea } from "./PageArea";
import { SystemBrowserBar } from "./SystemBrowserBar";
import type { Surface } from "../state/filesView";

// Two frames: the first commits the view, the second runs after it has been painted. A stable
// function, so a re-render does not run it again.
function markPainted(node: HTMLElement | null) {
  if (node === null) return;
  const frame = requestAnimationFrame(() =>
    requestAnimationFrame(() => performance.mark("board:browser-painted")),
  );
  return () => cancelAnimationFrame(frame);
}

/** What a browser tab of the main view shows: a native page inside Electron, or the engine's agent tabs everywhere. */
export function BrowserSurface({ surface }: { surface: Surface }) {
  const { tabs } = useAtomValue(browserAtom);
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeId) ?? null;
  return (
    <div
      ref={markPainted}
      aria-label="Browser"
      data-testid="browser-view"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {surface === "page" ? (
        <>
          <AddressBar key={active?.id} tab={active} />
          <PageArea />
        </>
      ) : (
        <>
          <AgentTabView />
          {browserHost === null && <SystemBrowserBar />}
        </>
      )}
    </div>
  );
}
