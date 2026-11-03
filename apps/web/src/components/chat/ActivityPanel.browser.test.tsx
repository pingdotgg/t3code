import type { ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ActivityPanel } from "./ActivityPanel";

const mocks = vi.hoisted(() => ({ loaded: false }));

vi.mock("~/state/entities", () => ({
  useQuietThreadProjection: () => (mocks.loaded ? { projection: {} } : null),
  useQuietThreadVisibleTurnItems: () => [],
}));
vi.mock("@t3tools/client-runtime/state/thread-execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/thread-execution")>()),
  deriveThreadStructureRuntime: () => null,
  deriveProviderSubagentStatus: () => null,
}));

const threadRef = { environmentId: "env", threadId: "thread" } as unknown as ScopedThreadRef;

function setup(loaded: boolean) {
  mocks.loaded = loaded;
  return (
    <ActivityPanel
      threadRef={threadRef}
      workspaceRoot={undefined}
      onOpenFile={vi.fn()}
      approvals={{ pending: [], respondingRequestIds: [], canOperate: true, onRespond: vi.fn() }}
    />
  );
}

it("says nothing while the thread is loading, instead of claiming there is nothing to show", async () => {
  await using screen = await render(setup(false));

  expect(screen.container.textContent).toBe("");
});

it("explains the empty state once a thread has loaded with no activity", async () => {
  await using _screen = await render(setup(true));

  await expect.element(page.getByText("Nothing to show yet")).toBeVisible();
});
