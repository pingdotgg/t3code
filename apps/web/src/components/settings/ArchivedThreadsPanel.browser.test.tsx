import { render } from "../../../test/render";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type ReactNode, useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  unarchive: vi.fn(),
  threads: [] as Array<Record<string, unknown>>,
  loaded: true,
  listeners: new Set<() => void>(),
}));

function deliverArchive() {
  state.loaded = true;
  for (const listener of state.listeners) listener();
}

vi.mock(import("@t3tools/client-runtime/state/shell"), async (original) => ({
  ...(await original()),
  presentThreadShell: ((environmentId: string, thread: object) => ({
    ...thread,
    environmentId,
  })) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: ["env-a"] },
    groups: [],
    environments: [],
  })) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: (() => {
    const loaded = useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.loaded,
    );
    return {
      snapshots: loaded
        ? [
            {
              environmentId: "env-a",
              snapshot: {
                projects: [{ id: "project-a", title: "Project A" }],
                threads: state.threads,
              },
            },
          ]
        : [],
      error: null,
      isLoading: !loaded,
      refresh: vi.fn(),
    };
  }) as never,
}));
vi.mock(import("../../hooks/useThreadActions"), () => ({
  useThreadActions: (() => ({
    unarchiveThread: state.unarchive,
    confirmAndDeleteThread: vi.fn(),
  })) as never,
}));
vi.mock(import("../ProjectFavicon"), () => ({ ProjectFavicon: (() => null) as never }));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => (
    <div data-settings-page-scroll style={{ height: 400, overflowY: "auto" }}>
      {children}
    </div>
  )) as never,
  SettingsRow: (({ title, control }: { title: ReactNode; control: ReactNode }) => (
    <div style={{ height: 64 }}>
      {title}
      {control}
    </div>
  )) as never,
}));

import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

function setup({ loaded = true } = {}) {
  state.loaded = loaded;
  state.listeners.clear();
  state.unarchive.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.threads = Array.from({ length: 200 }, (_, index) => ({
    id: `thread-${index}`,
    projectId: "project-a",
    title: `Thread ${index}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: new Date(Date.UTC(2026, 5, 1) - index * 60_000).toISOString(),
  }));
}

it("keeps every archived row findable in page and actionable", async () => {
  setup();
  await using screen = await render(<ArchivedThreadsPanel />);
  await expect.element(screen.getByRole("button", { name: "Unarchive Thread 0" })).toBeVisible();

  await expect
    .element(screen.getByRole("button", { name: "Unarchive Thread 199" }))
    .toBeInTheDocument();
  // Chromium's find-in-page; absent from the DOM typings.
  const find: (text: string, ...flags: boolean[]) => boolean = Reflect.get(window, "find");
  expect(find.call(window, "Thread 199", false, false, true)).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Unarchive Thread 199" }));

  expect(state.unarchive).toHaveBeenCalledWith(
    scopeThreadRef("env-a" as never, "thread-199" as never),
  );
});

it("paints the first rows before the rest when the archive arrives after loading", async () => {
  setup({ loaded: false });
  await using screen = await render(<ArchivedThreadsPanel />);
  await expect.element(screen.getByText("Loading archived threads")).toBeVisible();

  const unarchiveButtons = () =>
    document.querySelectorAll('button[aria-label^="Unarchive Thread"]').length;
  const firstCommitRows = new Promise<number>((resolve) => {
    const observer = new MutationObserver(() => {
      const count = unarchiveButtons();
      if (count === 0) return;
      observer.disconnect();
      resolve(count);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  deliverArchive();

  expect(await firstCommitRows).toBe(40);
  await expect
    .element(screen.getByRole("button", { name: "Unarchive Thread 199" }))
    .toBeInTheDocument();
});
