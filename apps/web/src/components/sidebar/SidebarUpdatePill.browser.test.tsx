import type { DesktopUpdateState, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import type { RestartingMachine, UpdateEverythingRow } from "./updateEverything.logic";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
    rows: [] as ReadonlyArray<UpdateEverythingRow>,
    restarts: [] as ReadonlyArray<RestartingMachine>,
    run: vi.fn(async () => {}),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));
// The pill only renders in the desktop app.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("./useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: mocks.hasUpdates,
    summary: "Update everything",
    version: null,
    providerCount: 0,
    rows: mocks.rows,
    restarts: mocks.restarts,
    run: mocks.run,
  }),
}));

function nightlyUpdate(releaseNotes: DesktopUpdateState["releaseNotes"]): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.50-nightly.2",
    downloadedVersion: null,
    releaseNotes,
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

const RELEASE_NOTES: DesktopUpdateState["releaseNotes"] = [
  { version: "0.0.50-nightly.2", items: ["Faster sidebar."], totalItems: 1 },
];

function setup(
  update: DesktopUpdateState | null,
  {
    hasUpdates = false,
    rows = [] as ReadonlyArray<UpdateEverythingRow>,
    restarts = [] as ReadonlyArray<RestartingMachine>,
  } = {},
) {
  mocks.update = update;
  mocks.hasUpdates = hasUpdates;
  mocks.rows = rows;
  mocks.restarts = restarts;
  mocks.run.mockClear();
}

function publish(update: DesktopUpdateState | null) {
  return act(() => {
    mocks.update = update;
    mocks.notify();
  });
}

const releaseNotes = () => document.querySelector('[aria-label="Update release notes"]');

describe("SidebarUpdatePill release notes", () => {
  it("closes when the release notes stop applying", async () => {
    setup(nightlyUpdate(RELEASE_NOTES));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());

    await publish(nightlyUpdate([]));
    await vi.waitFor(() => expect(releaseNotes()).toBeNull());
  });

  it("opens when release notes arrive while the trigger has keyboard focus", async () => {
    setup(nightlyUpdate([]));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    expect(releaseNotes()).toBeNull();

    await publish(nightlyUpdate(RELEASE_NOTES));
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());
  });
});

describe("SidebarUpdatePill update everything", () => {
  it("does not refocus the update button after a pointer cancel", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect.element(cancel).toBeVisible();

    await userEvent.click(cancel);
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(document.activeElement).not.toBe(button.element());
  });

  it("returns focus to the update button after Escape", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(button.element()));
  });

  const studio = "studio" as EnvironmentId;
  const interruption = /interrupt/i;

  it.each([
    { choice: "Cancel", runs: 0 },
    { choice: "Update", runs: 1 },
  ] as const)(
    "warns that a restarting machine with no loaded threads interrupts running work ($choice)",
    async ({ choice, runs }) => {
      setup(null, {
        hasUpdates: true,
        rows: [
          {
            environmentId: studio,
            label: "Studio",
            app: "desktop-app",
            skipped: null,
            providers: [],
          },
        ],
        restarts: [{ environmentId: studio, continuesThreads: true }],
      });
      await using screen = await render(<SidebarUpdatePill />);
      await userEvent.click(screen.getByRole("button", { name: "Update everything" }));
      const dialog = page.getByRole("alertdialog");
      await expect.element(dialog.getByText(interruption)).toBeVisible();
      await expect.element(dialog).toHaveAccessibleDescription(interruption);

      await userEvent.click(dialog.getByRole("button", { name: choice, exact: true }));
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(runs));
    },
  );

  it("does not warn about interruptions when only providers update", async () => {
    setup(null, {
      hasUpdates: true,
      rows: [
        { environmentId: studio, label: "Studio", app: null, skipped: null, providers: ["Codex"] },
      ],
    });
    await using screen = await render(<SidebarUpdatePill />);
    await userEvent.click(screen.getByRole("button", { name: "Update everything" }));
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByText("Codex")).toBeVisible();
    expect(dialog.getByText(interruption).query()).toBeNull();
  });

  it("keeps a blocked app update's description valid and its confirmation disabled", async () => {
    setup(null);
    await using _screen = await render(
      <UpdateEverythingDialog
        open
        onOpenChange={() => {}}
        version={null}
        providerCount={0}
        rows={[
          {
            environmentId: studio,
            label: "Studio",
            app: "desktop-app",
            skipped: null,
            providers: [],
          },
        ]}
        restarts={[]}
        disabledReason="An environment is not connected."
        onConfirm={() => {}}
      />,
    );
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByText("An environment is not connected.")).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: "Update", exact: true }))
      .toBeDisabled();
    expect(dialog.getByText(interruption).query()).toBeNull();
    const descriptionIds = dialog.element().getAttribute("aria-describedby")?.split(/\s+/);
    expect(descriptionIds?.length).toBeGreaterThan(0);
    for (const id of descriptionIds ?? []) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});
