import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { T3Shell } from "@t3tools/contracts/shell";

import { closeShellContextMenu, showShellContextMenu } from "./shellContextMenu";

type ActionListener = (type: string, payload: unknown) => void;

// One shell for the file: the module subscribes to `onAction` once per document.
const listeners = new Set<ActionListener>();
const publish = vi.fn(async (_key: string, _value: unknown) => {});
const shell = {
  protocolVersion: 1,
  surfaceId: "primary",
  ready: Promise.resolve({}),
  publish,
  onAction: async (listener: ActionListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: async () => ({}),
  onState: async () => () => {},
  dispatch: async () => {},
} satisfies T3Shell;

function select(requestId: string, id: string | null) {
  for (const listener of listeners) listener("contextMenu.select", { requestId, id });
}

function lastPublished<T>(): T {
  return publish.mock.calls.at(-1)?.[1] as T;
}

vi.stubGlobal("window", { t3Shell: shell });

const items: ContextMenuItem<"rename" | "delete">[] = [
  { id: "rename", label: "Rename" },
  { id: "delete", label: "Delete", destructive: true, separatorBefore: true },
];

afterEach(() => {
  closeShellContextMenu();
  publish.mockClear();
  vi.stubGlobal("window", { t3Shell: shell });
});

describe("showShellContextMenu", () => {
  it("publishes the menu for the calling surface and resolves the selected id", async () => {
    const result = showShellContextMenu(items, { x: 10, y: 20 });
    await Promise.resolve();
    const published = lastPublished<{
      requestId: string;
      surfaceId: string;
      x: number;
      y: number;
      items: unknown[];
    }>();
    expect(published).toMatchObject({ surfaceId: "primary", x: 10, y: 20 });
    expect(published.requestId).toMatch(/^primary:/);
    expect(published.items).toEqual([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true, separatorBefore: true },
    ]);
    select(published.requestId, "delete");
    await expect(result).resolves.toBe("delete");
    // The shell clears its menu once a choice is in.
    expect(lastPublished()).toBeNull();
  });

  it("targets the window when the caller passes the shell surface", async () => {
    const result = showShellContextMenu(items, { x: 1, y: 2, surface: "shell" });
    await Promise.resolve();
    const published = lastPublished<{ requestId: string; surfaceId: string }>();
    expect(published.surfaceId).toBe("shell");
    select(published.requestId, null);
    await expect(result).resolves.toBeNull();
  });

  it("namespaces request ids by the calling document", async () => {
    vi.stubGlobal("window", {
      t3Shell: {
        ...shell,
        surfaceId: "rightPanel",
      } satisfies T3Shell,
    });

    const result = showShellContextMenu(items);
    await Promise.resolve();

    const published = lastPublished<{ requestId: string }>();
    expect(published.requestId).toMatch(/^rightPanel:/);
    closeShellContextMenu();
    await expect(result).resolves.toBeNull();
  });

  it("ignores selections for another request and resolves null on close", async () => {
    const result = showShellContextMenu(items);
    await Promise.resolve();
    const published = lastPublished<{ requestId: string }>();
    select(`${published.requestId}:other`, "rename");
    closeShellContextMenu();
    await expect(result).resolves.toBeNull();
  });

  it("dismisses the previous request when a new menu replaces it", async () => {
    const firstResult = vi.fn();
    void showShellContextMenu(items).then(firstResult);

    const second = showShellContextMenu(items);
    await Promise.resolve();

    expect(firstResult).toHaveBeenCalledWith(null);
    closeShellContextMenu();
    await expect(second).resolves.toBeNull();
  });

  it("resolves null without a shell", async () => {
    vi.stubGlobal("window", {});
    await expect(showShellContextMenu(items)).resolves.toBeNull();
  });
});
