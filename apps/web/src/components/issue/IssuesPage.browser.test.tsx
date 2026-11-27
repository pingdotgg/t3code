import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const selectedIssue = {
  who: "all",
  status: "open",
  selectedEnvironmentId: "env-1",
  selectedProjectId: "project-1",
  tracker: "github",
  scope: "owner/repo",
  key: "7",
} as const;
const state = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useSearch: (() => selectedIssue) as never,
  // The page reads its search from the layout location, which falls back to the router's.
  useLocation: ((options?: { select?: (location: unknown) => unknown }) => {
    const location = {
      href: "/issues",
      pathname: "/issues",
      hash: "",
      search: selectedIssue,
      state: {},
    };
    return options?.select ? options.select(location) : location;
  }) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "env-1",
        label: "Local",
        serverConfig: { environment: { capabilities: { issues: true } } },
      },
    ],
  })) as never,
  useIssuesSupported: () => true,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));
vi.mock(import("~/state/issues"), async (original) => ({
  ...(await original()),
  useIssueList: (() => ({
    answers: [],
    isPending: false,
    error: null,
    refresh: () => {},
    reload: () => {},
    retry: () => {},
  })) as never,
}));

import {
  ISSUES_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { IssuesPage } from "./IssuesPage";

function setup() {
  state.navigate.mockReset();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
}

const panelSurfaces = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ISSUES_PANEL_REF).surfaces;

describe("IssuesPage shortcuts", () => {
  it("closes the active issue tab on the right panel close shortcut", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using _screen = await render(<IssuesPage />);
    expect(panelSurfaces()).toHaveLength(1);

    await act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(panelSurfaces()).toEqual([]);
    expect(state.navigate).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { who: "all", status: "open" } }),
    );
  });
});
