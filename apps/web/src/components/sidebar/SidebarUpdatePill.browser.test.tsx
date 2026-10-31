import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
    hasProviderUpdates: false,
    hasAppUpdates: false,
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
vi.mock("./useUpdateEverything", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useUpdateEverything: (
      _version: string | null,
      options?: { includeProviderUpdates: boolean },
    ) => {
      const hasAppUpdates = useSyncExternalStore(mocks.subscribe, () => mocks.hasAppUpdates);
      return {
        hasUpdates: mocks.hasUpdates,
        hasAppUpdates: _version !== null || hasAppUpdates,
        canChooseProviderUpdates: mocks.hasProviderUpdates && (_version !== null || hasAppUpdates),
        summary: "Update everything",
        version: null,
        providerCount:
          mocks.hasProviderUpdates && options?.includeProviderUpdates !== false ? 1 : 0,
        rows: [],
        restarts: [],
      };
    },
  };
});

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
  { hasUpdates = false, hasProviderUpdates = false, hasAppUpdates = false } = {},
) {
  mocks.update = update;
  mocks.hasUpdates = hasUpdates;
  mocks.hasProviderUpdates = hasProviderUpdates;
  mocks.hasAppUpdates = hasAppUpdates;
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
  it("requires a new confirmation if the last app-update target disappears", async () => {
    setup(null, { hasUpdates: true, hasProviderUpdates: true, hasAppUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    const checkbox = page.getByRole("checkbox", { name: "Include provider updates" });
    await expect.element(checkbox).toBeVisible();

    await act(() => {
      mocks.hasAppUpdates = false;
      mocks.notify();
    });
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await userEvent.click(button);
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await expect.element(checkbox).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "remembers the provider choice in another client (already mounted: %s)",
    async (alreadyMounted) => {
      setup(nightlyUpdate([]), { hasUpdates: true, hasProviderUpdates: true });
      const key = "t3code:include-providers-in-app-updates";
      const previous = localStorage.getItem(key);
      using _storage = {
        [Symbol.dispose]() {
          if (previous === null) localStorage.removeItem(key);
          else localStorage.setItem(key, previous);
        },
      };
      localStorage.removeItem(key);
      const renderClient = (id: string) => {
        const container = document.createElement("div");
        container.id = id;
        return render(<SidebarUpdatePill />, { container });
      };
      await using clients = new AsyncDisposableStack();
      const screen = clients.use(await renderClient("update-client-first"));
      const other = alreadyMounted ? clients.use(await renderClient("update-client-second")) : null;
      await userEvent.click(screen.getByRole("button", { name: "Update everything" }));
      const checkbox = page.getByRole("checkbox", { name: "Include provider updates" });
      await expect.element(checkbox).toBeChecked();
      await userEvent.click(checkbox);
      await expect.element(checkbox).not.toBeChecked();
      expect(localStorage.getItem(key)).toBe("false");
      await screen.unmount();

      const restored = other ?? clients.use(await renderClient("update-client-second"));
      await userEvent.click(restored.getByRole("button", { name: "Update everything" }));
      await expect.element(checkbox).not.toBeChecked();
      await act(() => {
        localStorage.setItem(key, "true");
        window.dispatchEvent(new StorageEvent("storage", { key, newValue: "true" }));
      });
      await expect.element(checkbox).not.toBeChecked();
      await userEvent.click(checkbox);
      await expect.element(checkbox).toBeChecked();
      expect(localStorage.getItem(key)).toBe("true");
    },
  );

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
