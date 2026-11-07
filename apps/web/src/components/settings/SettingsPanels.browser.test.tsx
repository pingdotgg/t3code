import type { DesktopUpdateCommandRequest, DesktopUpdateState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render, stubGlobal } from "../../../test/render";
import "../../index.css";
import { AboutSettingsPanel } from "./SettingsPanels";
import { DesktopUpdateCoordinator } from "../desktop/DesktopUpdateCoordinator";

const mocks = vi.hoisted(() => ({ state: null as DesktopUpdateState | null }));
vi.mock("../../state/desktopUpdate", async (original) => ({
  ...(await original<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: () => mocks.state,
}));
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("../sidebar/useUpdateEverything", () => ({
  isHostedByThisApp: () => false,
  useUpdateEverything: () => ({
    hasUpdates: true,
    version: null,
    providerCount: 1,
    rows: [
      {
        environmentId: null,
        label: "Remote machine",
        app: "server",
        skipped: null,
        providers: ["Codex"],
      },
    ],
    restarts: [],
  }),
}));

it("About checks the coordinated plan for remote/provider offers when the app is current", async () => {
  const state: DesktopUpdateState = {
    enabled: true,
    status: "up-to-date",
    channel: "latest",
    currentVersion: "0.1.7",
    availableVersion: null,
    downloadedVersion: null,
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
  mocks.state = state;
  let listener: ((request: DesktopUpdateCommandRequest) => void) | undefined;
  using _bridge = stubGlobal("desktopBridge", {
    getUpdateState: async () => state,
    checkForUpdate: async () => ({ checked: true, state }),
    getLocalEnvironmentBootstraps: () => [],
    updateCommand: {
      setReady: async () => undefined,
      complete: async () => true,
      request: async () => {
        listener?.({ version: 1, requestId: "about", type: "update" });
        return { version: 1, requestId: "about", ok: true, status: "cancelled" };
      },
      onRequest: (callback: typeof listener) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
  });
  await using screen = await render(
    <>
      <AboutSettingsPanel />
      <DesktopUpdateCoordinator />
    </>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Check for Updates", exact: true }));
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  await expect.element(page.getByText("Remote machine", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Codex", { exact: true })).toBeVisible();
});
