// Conn UI lab: the real app on fixture data, for fast design iteration without a server or
// Orbit. Threads, projects and settings come from ./fixtures; edit those to change the data.
import "@fontsource-variable/inter";
import "./lab.css";
import { createHashHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import ReactDOM from "react-dom/client";
import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { initializeI18n } from "~/i18n/initializeI18n";
import { whenLocaleReady } from "~/i18n/runtime";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ENVIRONMENT_ID, installFakeEnvironment } from "../../web/test/fakeEnvironment";
import { LAB_PROJECTS, LAB_PROVIDERS, LAB_THREADS } from "./fixtures";
import { installLabDesktopBridge } from "./desktopBridge";
import { registerLabEnvironments } from "./registerEnvironments";
import { mountIconSwitcher } from "./icons/IconSwitcher";
import { installPullRequestListFixture } from "./pr/pullRequestList";

// The app initializes GT at startup, as test/browserSetup.ts does for the render tests.
initializeI18n(() => {});
installFakeEnvironment(LAB_THREADS, {
  extraProjects: LAB_PROJECTS,
  providers: LAB_PROVIDERS,
  pullRequests: true,
});
// The Database panel reads through the desktop bridge's databaseRun (src/desktopBridge.ts).
installLabDesktopBridge();
// The Pull requests page lists LAB_PULL_REQUESTS (src/pr/pullRequestList.ts).
installPullRequestListFixture();
// A returning user: the first-run gate would otherwise wait on onboarding evidence.
// The Working shelf is off, so waiting threads list inline like Nick's sidebar.
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  sidebarWorkingShelfEnabled: false,
});

// Tasks runs on Conn's own Orbit fixtures (src/orbit/tasks/orbitTasksFixtures.ts).
try {
  window.localStorage.setItem("conn:orbit-tasks-fixture", "default");
} catch {
  /* The lab still renders without Tasks. */
}

const params = new URLSearchParams(window.location.search);
const threadId = params.get("thread") ?? LAB_THREADS[0]!.id;
// The route lives in the URL hash, so a live reload keeps the open thread.
if (!window.location.hash || params.has("thread"))
  window.location.hash = `/${ENVIRONMENT_ID}/${threadId}`;
const router = getRouter(createHashHistory());
await router.load();
// The MacBook and Linux VM environments host some threads (src/environments.ts).
await registerLabEnvironments();
// The right panel opens on Tasks unless `?panel=none`; `?panel=files` and `?panel=database` open
// the lab's dummy Files and Database tabs.
const panel = params.get("panel");
if (panel !== "none") {
  const kind = panel === "files" || panel === "database" ? panel : "tasks";
  useRightPanelStore.getState().open(scopeThreadRef(ENVIRONMENT_ID, threadId as never), kind);
}
await whenLocaleReady();
ReactDOM.createRoot(document.getElementById("root")!).render(<AppRoot router={router} />);
// Icon set switch (?icons=original|outline|solid24|solid20|solid16|auto), src/icons.
mountIconSwitcher();
