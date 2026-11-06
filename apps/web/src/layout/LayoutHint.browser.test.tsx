import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";

import "../index.css";

import { act, render } from "../../test/render";
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

function Workspace({
  composerHeight,
  scale = 1,
}: {
  composerHeight: number | null;
  scale?: number;
}) {
  return (
    <div data-overview-stage style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
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

function setup() {
  const previous = useLayoutStore.getState();
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
  return { [Symbol.dispose]: () => useLayoutStore.setState(previous) };
}

it("lifts the hint when a deferred chat mounts its composer and resizes it", async () => {
  using _restore = setup();
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

it("clears the rendered composer throughout the overview closing zoom", async () => {
  using _restore = setup();
  const hintState = useLayoutStore.getState().hint;
  useLayoutStore.setState({ overviewOpen: false, hint: null });
  await using screen = await render(<Workspace composerHeight={240} scale={0.5} />);
  const stage = screen.container.querySelector<HTMLElement>("[data-overview-stage]")!;
  const pane = screen.container.querySelector<HTMLElement>("[data-layout-pane-id]")!;
  const composer = screen.container.querySelector<HTMLElement>(
    '[data-chat-composer-stack="true"]',
  )!;
  await act(() => useLayoutStore.setState({ overviewOpen: true }));
  expect(pane.getBoundingClientRect().height).toBe(300);
  await act(() => useLayoutStore.setState({ overviewOpen: false, hint: hintState }));
  await expect.element(screen.getByRole("status")).toBeVisible();
  const hint = screen.container.querySelector<HTMLElement>("[data-layout-hint]")!;
  await vi.waitFor(() => expect(hint.style.bottom).toBe("252px"));

  const animation = stage.animate([{ transform: "scale(0.5)" }, { transform: "scale(1)" }], {
    duration: 1000,
    fill: "forwards",
  });
  using _animation = { [Symbol.dispose]: () => animation.cancel() };
  animation.pause();
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    animation.currentTime = progress * 1000;
    const scale = 0.5 + progress * 0.5;
    await vi.waitFor(() => {
      expect(pane.getBoundingClientRect().height).toBeCloseTo(600 * scale);
      expect(hint.style.bottom).toBe("252px");
      expect(
        composer.getBoundingClientRect().top - hint.getBoundingClientRect().bottom,
      ).toBeCloseTo(12 * scale);
    });
    expect(hint.parentElement).toBe(pane);
  }
});
