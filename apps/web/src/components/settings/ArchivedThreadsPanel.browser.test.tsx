import { render } from "../../../test/render";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  unarchive: vi.fn(),
  threads: [] as Array<Record<string, unknown>>,
}));

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
  useArchivedThreadSnapshots: (() => ({
    snapshots: [
      {
        environmentId: "env-a",
        snapshot: { projects: [{ id: "project-a", title: "Project A" }], threads: state.threads },
      },
    ],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  })) as never,
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

function setup() {
  state.unarchive.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.threads = Array.from({ length: 200 }, (_, index) => ({
    id: `thread-${index}`,
    projectId: "project-a",
    title: `Thread ${index}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: new Date(Date.UTC(2026, 5, 1) - index * 60_000).toISOString(),
  }));
}

it("mounts archived rows near the page scroll position and keeps far rows actionable", async () => {
  setup();
  await using screen = await render(<ArchivedThreadsPanel />);
  await expect.element(screen.getByRole("button", { name: "Unarchive Thread 0" })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Unarchive / }).elements().length).toBeLessThan(50);
  expect(screen.getByRole("button", { name: "Unarchive Thread 199" }).query()).toBeNull();

  const scroller = document.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
  scroller.scrollTop = scroller.scrollHeight;
  await userEvent.click(screen.getByRole("button", { name: "Unarchive Thread 199" }));

  expect(state.unarchive).toHaveBeenCalledWith(
    scopeThreadRef("env-a" as never, "thread-199" as never),
  );
});
