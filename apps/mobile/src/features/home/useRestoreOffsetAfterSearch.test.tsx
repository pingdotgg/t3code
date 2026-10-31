import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { WorkspaceSearchMode } from "../workspace/workspace-tabs-state";
import { useRestoreOffsetAfterSearch } from "./useRestoreOffsetAfterSearch";

type Props = { mode: WorkspaceSearchMode | undefined; offset: number | undefined };

function mountProbe() {
  const restore = vi.fn();
  function Probe(props: Props) {
    useRestoreOffsetAfterSearch(props.mode, props.offset, restore);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    restore,
    render: (props: Props) => act(async () => root.render(<Probe {...props} />)),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("leaves the list where UIKit rested it when Home mounts at rest", async () => {
  using screen = mountProbe();
  await screen.render({ mode: "resting", offset: 0 });
  await screen.render({ mode: "resting", offset: 0 });
  expect(screen.restore).not.toHaveBeenCalled();
  await screen.render({ mode: undefined, offset: undefined });
  await screen.render({ mode: "resting", offset: 0 });
  expect(screen.restore).not.toHaveBeenCalled();
});

it("restores the saved offset when active or expanded search returns to resting", async () => {
  using screen = mountProbe();
  await screen.render({ mode: "resting", offset: 120 });
  await screen.render({ mode: "active", offset: 120 });
  await screen.render({ mode: "expanded", offset: 120 });
  expect(screen.restore).not.toHaveBeenCalled();

  await screen.render({ mode: "resting", offset: 80 });
  expect(screen.restore).toHaveBeenCalledExactlyOnceWith(80);

  await screen.render({ mode: "active", offset: 80 });
  await screen.render({ mode: "resting", offset: 200 });
  expect(screen.restore).toHaveBeenCalledTimes(2);
  expect(screen.restore).toHaveBeenLastCalledWith(200);
});

it("does not scroll again when the saved offset changes while resting", async () => {
  using screen = mountProbe();
  await screen.render({ mode: "active", offset: 50 });
  await screen.render({ mode: "resting", offset: 50 });
  await screen.render({ mode: "resting", offset: 300 });
  expect(screen.restore).toHaveBeenCalledExactlyOnceWith(50);
});
