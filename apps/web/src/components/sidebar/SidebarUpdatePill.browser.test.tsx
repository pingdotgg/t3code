import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { waitForUpdateRestart, postponeUpdateRestart } from "./updateEverythingRun";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
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
    rows: [],
    restarts: [],
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

function setup(update: DesktopUpdateState | null, { hasUpdates = false } = {}) {
  mocks.update = update;
  mocks.hasUpdates = hasUpdates;
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

it.each(["click", "Enter", " "])("skips the restart countdown with %s", async (input) => {
  setup(null);
  using _now = vi.spyOn(Date, "now").mockReturnValue(0);
  await using screen = await render(
    <SidebarUpdateCapsule
      run={{ localVersion: "1.1.0", phase: "servers", restartAt: null, machines: [] }}
      local={null}
      icon={null}
    />,
  );
  await userEvent.tab();
  await screen.rerender(
    <SidebarUpdateCapsule
      run={{ localVersion: "1.1.0", phase: "countdown", restartAt: 5_000, machines: [] }}
      local={null}
      icon={null}
    />,
  );
  const decision = waitForUpdateRestart(20_000);
  try {
    const restart = screen.getByRole("button", { name: /Restart now/ });
    expect(document.activeElement).toBe(restart.element());
    if (input === "click") await userEvent.click(restart);
    else {
      await userEvent.keyboard(input === "Enter" ? "{Enter}" : " ");
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const resolved = vi.fn();
    void decision.then(resolved);
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(true));
  } finally {
    postponeUpdateRestart();
  }
});

it("keeps Later separate from restarting immediately", async () => {
  setup(null);
  using _now = vi.spyOn(Date, "now").mockReturnValue(0);
  await using screen = await render(
    <SidebarUpdateCapsule
      run={{ localVersion: "1.1.0", phase: "servers", restartAt: null, machines: [] }}
      local={null}
      icon={null}
    />,
  );
  await userEvent.click(screen.getByRole("button"));
  await expect.element(page.getByText("This app", { exact: true })).toBeVisible();
  await screen.rerender(
    <SidebarUpdateCapsule
      run={{ localVersion: "1.1.0", phase: "countdown", restartAt: 5_000, machines: [] }}
      local={null}
      icon={null}
    />,
  );
  await expect.element(page.getByText("This app", { exact: true })).toBeVisible();
  const decision = waitForUpdateRestart(5_000);
  try {
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    await expect(decision).resolves.toBe(false);
  } finally {
    postponeUpdateRestart();
  }
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
});
