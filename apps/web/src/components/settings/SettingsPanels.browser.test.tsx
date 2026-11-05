import { EnvironmentId, type DesktopUpdateState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { AboutSettingsPanel } from "./SettingsPanels";

const mocks = vi.hoisted(() => ({
  update: null as DesktopUpdateState | null,
  confirm: async (_message: string) => true,
}));
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: () => mocks.update,
}));
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  ensureLocalApi: () => ({ dialogs: { confirm: (message: string) => mocks.confirm(message) } }),
}));
// A paired background service on this machine is behind the downloaded desktop version.
vi.mock("../sidebar/useUpdateEverything", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sidebar/useUpdateEverything")>()),
  useUpdateEverything: () => ({
    hasUpdates: true,
    summary: "Update 2 machines",
    version: "0.0.51",
    providerCount: 0,
    rows: [
      {
        environmentId: null,
        label: "This app",
        app: "this-app",
        skipped: null,
        providers: [],
      },
      {
        environmentId: EnvironmentId.make("background-service"),
        label: "Background service",
        app: "server",
        skipped: null,
        providers: [],
      },
    ],
    restarts: [],
    run: async () => {},
  }),
}));

function downloadedUpdate(): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.0.50",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.51",
    downloadedVersion: "0.0.51",
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

function setup() {
  mocks.update = downloadedUpdate();
  const confirm = vi.fn(async (_message: string) => true);
  mocks.confirm = confirm;
  const installUpdate = vi.fn(async () => ({ accepted: true, completed: false }));
  const bridge = stubGlobal("desktopBridge", {
    installUpdate,
    downloadUpdate: vi.fn(),
    checkForUpdate: vi.fn(),
    cliCommand: {
      getState: async () => ({
        supported: false,
        installedPath: null,
        onPath: false,
        launcherPath: null,
      }),
    },
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });
  return { bridge, confirm, installUpdate };
}

it("installing a downloaded update from About also offers to update a behind server", async () => {
  const { bridge, confirm, installUpdate } = setup();
  using _bridge = bridge;
  await using screen = await render(<AboutSettingsPanel />);

  await userEvent.click(screen.getByRole("button", { name: "Install" }));

  const dialog = page.getByRole("alertdialog", { name: "Update 2 machines?" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText("Background service")).toBeVisible();
  expect(confirm).not.toHaveBeenCalled();
  expect(installUpdate).not.toHaveBeenCalled();
});
