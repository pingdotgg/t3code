import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../index.css";

import { startDemoServer } from "./server";
import { seedDemoClientState } from "./seed";
import { installDemoStageBridge } from "./stage";

installDemoStageBridge();
startDemoServer();

function wheelDeltaInPixels(event: WheelEvent, scrollTarget: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * scrollTarget.clientHeight;
  }
  return event.deltaY;
}

function verticalScrollTarget(event: WheelEvent): HTMLElement | null {
  if (event.deltaY === 0) {
    return null;
  }

  for (const candidate of event.composedPath()) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }
    const { overflowY } = window.getComputedStyle(candidate);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      candidate.scrollHeight > candidate.clientHeight + 1 &&
      (event.deltaY < 0
        ? candidate.scrollTop > 0
        : candidate.scrollTop + candidate.clientHeight < candidate.scrollHeight - 1)
    ) {
      return candidate;
    }
  }

  return null;
}

// The hero scales its same-origin iframe to preserve the desktop app layout.
// Some browsers lose default wheel scrolling on transformed virtualized
// scrollers, so the demo applies the gesture to the real element under the
// pointer. This remains user-driven and works for every scrollable app surface.
function installDemoWheelScrolling(): void {
  document.addEventListener(
    "wheel",
    (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.shiftKey) {
        return;
      }
      const scrollTarget = verticalScrollTarget(event);
      if (!scrollTarget) {
        return;
      }
      event.preventDefault();
      scrollTarget.scrollTop += wheelDeltaInPixels(event, scrollTarget);
    },
    { capture: true, passive: false },
  );
}

installDemoWheelScrolling();

// First-visit state (Sidebar v2 on, remote machines registered, browser panel
// open on showcase threads) must land before the app boots and reads it, so
// the app modules (whose stores rehydrate persisted state on import) are
// loaded only after seeding completes.
async function renderDemo(): Promise<void> {
  try {
    await seedDemoClientState();
  } catch (error) {
    console.warn("Could not seed the marketing demo; continuing with browser defaults.", error);
  }

  if (window.location.hash === "" || window.location.hash === "#/") {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#/demo-mac-studio/thread-flaky`,
    );
  }

  const [{ getRouter }, { AppRoot }] = await Promise.all([
    import("../router"),
    import("../AppRoot"),
  ]);

  // Hash history keeps the demo self-contained on a single static page.
  const router = getRouter(createHashHistory());

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <AppRoot router={router} />
    </React.StrictMode>,
  );
}

void renderDemo();
