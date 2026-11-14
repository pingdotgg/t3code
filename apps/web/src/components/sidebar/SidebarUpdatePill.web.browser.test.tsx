import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import type { UpdateEverythingRow } from "./updateEverything.logic";

// Browser mode fixes a mocked export at module load, so the web client needs its own file.
const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    everything: {
      hasUpdates: true,
      summary: "Update everything",
      version: null,
      providerCount: 0,
      rows: [] as ReadonlyArray<UpdateEverythingRow>,
      restarts: [],
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: false,
}));
vi.mock("./useUpdateEverything", async () => ({
  useUpdateEverything: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.everything,
  ),
}));

function setup(rows: ReadonlyArray<UpdateEverythingRow>) {
  mocks.everything = { ...mocks.everything, hasUpdates: true, rows };
}

describe("SidebarUpdatePill on web", () => {
  it("keeps an open dialog when the updates finish and the pill hides", async () => {
    setup([
      { environmentId: null, label: "Laptop", app: null, skipped: null, providers: ["Codex"] },
    ]);
    await using screen = await render(<SidebarUpdatePill />);
    await userEvent.click(screen.getByRole("button", { name: "Update everything" }));
    await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();

    await act(() => {
      mocks.everything = { ...mocks.everything, hasUpdates: false, rows: [] };
      mocks.notify();
    });
    await expect
      .element(screen.getByRole("button", { name: "Update everything" }))
      .not.toBeInTheDocument();
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByText("Everything is up to date")).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Close" }));
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
  });
});
