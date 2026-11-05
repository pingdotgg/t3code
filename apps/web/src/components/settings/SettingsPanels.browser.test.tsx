import { type DesktopUpdateState, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { AboutVersionSection } from "./SettingsPanels";

const mocks = vi.hoisted(() => ({
  status: "downloaded" as DesktopUpdateState["status"],
  skipReason: null as string | null,
  confirm: null as unknown as (message: string) => Promise<boolean>,
}));
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (): DesktopUpdateState => ({
    enabled: true,
    status: mocks.status,
    channel: "latest",
    currentVersion: "0.1.2",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: "0.1.7",
    downloadedVersion: "0.1.7",
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  }),
}));
vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  ensureLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("../sidebar/useUpdateEverything", () => ({
  isHostedByThisApp: () => false,
  useUpdateEverything: () => ({
    hasUpdates: mocks.skipReason === null,
    summary: "Update this app and 1 server",
    version: "0.1.7",
    providerCount: 0,
    rows: [
      { environmentId: null, label: "This app", app: "this-app", skipped: null, providers: [] },
      {
        environmentId: EnvironmentId.make("service"),
        label: "Background service",
        app: mocks.skipReason === null ? "server" : null,
        skipped: mocks.skipReason,
        providers: [],
      },
    ],
    restarts: [],
    run: async () => {},
  }),
}));
vi.mock("./CliCommandSettingsRow", () => ({ CliCommandSettingsRow: () => null }));

function setup(skipReason: string | null) {
  mocks.status = "downloaded";
  mocks.skipReason = skipReason;
  const confirm = vi.fn(async () => false);
  mocks.confirm = confirm;
  return { confirm };
}

it.each([null, "no permission"])(
  "reviews the paired service before installing (skip: %s)",
  async (skipReason) => {
    const { confirm } = setup(skipReason);
    const installUpdate = vi.fn();
    using _bridge = stubGlobal("desktopBridge", { installUpdate });
    await using screen = await render(<AboutVersionSection />);

    await screen.getByRole("button", { name: "Install" }).click();

    await expect
      .element(page.getByText(skipReason === null ? "Update 2 machines?" : "Update 1 machine?"))
      .toBeVisible();
    if (skipReason !== null) {
      await page.getByRole("button", { name: "1 skipped" }).click();
      await expect.element(page.getByText(skipReason, { exact: true })).toBeVisible();
    }
    await expect.element(page.getByText("Background service")).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();

    mocks.status = "checking";
    await screen.rerender(<AboutVersionSection />);
    await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeDisabled();

    mocks.status = "downloaded";
    await screen.rerender(<AboutVersionSection />);
    await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(installUpdate).not.toHaveBeenCalled();
  },
);
