import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { LayoutStripHint } from "./LayoutHint";
import { useLayoutStore } from "./layoutStore";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: () => compileResolvedKeybindingsConfig([]),
}));
vi.mock(import("../state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryServerKeybindingsAtom: Atom.make(compileResolvedKeybindingsConfig([])) };
});
vi.mock(import("../state/entities"), () => ({ useThreadShell: () => null }));
vi.mock(import("./PaneTabs"), () => ({
  useLayoutTabLabel: () => ({ title: "Chat", tooltip: "Chat", icon: null }),
}));
vi.mock(import("./layoutCommands"), () => ({ countedLayoutWorkspaces: () => [] }));

function Workspace({ composerHeight }: { composerHeight: number | null }) {
  return (
    <div>
      <div
        data-layout-pane-id="pane"
        data-layout-tab-id="chat"
        style={{ position: "relative", width: 600, height: 600 }}
      >
        {composerHeight !== null && (
          <div
            data-chat-composer-stack="true"
            style={{ position: "absolute", bottom: 0, height: composerHeight, width: "100%" }}
          />
        )}
      </div>
      <LayoutStripHint />
    </div>
  );
}

it("lifts the hint when a deferred chat mounts its composer and resizes it", async () => {
  const previous = useLayoutStore.getState();
  using _restore = { [Symbol.dispose]: () => useLayoutStore.setState(previous) };
  useLayoutStore.setState({
    layout: {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: "Chat",
          focusedPaneId: "pane",
          cameraWidth: null,
          columns: [
            {
              id: "column",
              width: 1,
              panes: [
                {
                  id: "pane",
                  size: 1,
                  activeTabId: "chat",
                  tabs: [{ id: "chat", content: { kind: "settings" } }],
                },
              ],
            },
          ],
        },
      ],
    },
    hint: { id: 1, kind: "workspace-name", workspaceId: "workspace", index: 0, count: 2 },
  });
  await using screen = await render(<Workspace composerHeight={null} />);
  const pill = screen.getByRole("status");
  await expect.element(pill).toBeVisible();
  const hint = screen.container.querySelector<HTMLElement>("[data-layout-hint]")!;
  const pane = screen.container.querySelector("[data-layout-pane-id]");
  expect(hint.parentElement).toBe(pane);
  expect(hint.style.bottom).toBe("");

  await screen.rerender(<Workspace composerHeight={240} />);
  await vi.waitFor(() => expect(hint.style.bottom).toBe("252px"));
  await screen.rerender(<Workspace composerHeight={360} />);
  await vi.waitFor(() => expect(hint.style.bottom).toBe("372px"));
  await screen.rerender(<Workspace composerHeight={60} />);
  await vi.waitFor(() => expect(hint.style.bottom).toBe(""));
  expect(hint.parentElement).toBe(pane);
});
