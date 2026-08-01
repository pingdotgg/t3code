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
