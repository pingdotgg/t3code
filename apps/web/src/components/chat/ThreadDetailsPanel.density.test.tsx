import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { PopoverCreateHandle } from "../ui/popover";
import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";
import { ThreadDetailsPrRows } from "./ThreadDetailsPrRows";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverPopup: () => null,
  PopoverCreateHandle: () => ({}),
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => children,
}));

const resize = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock("../../lib/observeResize", () => ({
  observeResize: (_elements: unknown, callback: () => void) => {
    resize.callbacks.add(callback);
    return () => resize.callbacks.delete(callback);
  },
}));
vi.mock("./ChatCanvasContext", () => ({
  useChatCanvas: () => ({
    container: { width: 1800, height: 500 },
    lane: { padding: 48, minChatWidth: 640 },
    layout: { frame: null },
  }),
}));
vi.mock("../../hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock("../GitActionsControl", () => ({ default: () => null }));
vi.mock("../ProjectScriptsControl", () => ({ default: () => null }));
vi.mock("./ThreadAutomationsPanel", () => ({ ThreadAutomationsPanel: () => null }));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => <div data-thread-relationships-panel>Related threads</div>,
}));
vi.mock("./OpenInPicker", () => ({ OpenInPicker: () => <button>Open in…</button> }));
vi.mock("./ThreadDetailsPrRow", () => ({
  ThreadDetailsPrRow: ({ number }: { number: number }) => <button>Pull request #{number}</button>,
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/threads", () => ({ threadEnvironment: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({
  parseChangeRequestUrl: () => null,
  findProjectOnChangeRequestHost: () => undefined,
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: ({ panelSection }: { panelSection: string }) =>
    panelSection === "workspace" ? (
      <>
        <button>Machine</button>
        <button>Project</button>
      </>
    ) : (
      <ThreadDetailsPrRows
        threadRef={threadRef}
        links={links}
        currentLink={links[0]!}
        onOpenLink={vi.fn()}
        environmentId={threadRef.environmentId}
        pr={null}
        number={1}
        reference={links[0]!}
        status={null}
        project={null}
        label="#1"
        openAriaLabel="Open pull request"
        onOpen={vi.fn()}
      />
    ),
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment:thread-details-density"),
  threadId: ThreadId.make("thread:thread-details-density"),
};
const links = Array.from({ length: 70 }, (_, index): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: index + 1,
  url: `https://github.com/pingdotgg/t3code/pull/${index + 1}`,
  source: "manual",
  linkedAt: "2026-01-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
}));

it("keeps workspace controls after expanding and collapsing a long pull request list", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer!: ReactTestRenderer;
  // The renderer has no layout: rows are 40px, sections add 24px, and lineage adds 160px.
  // Measure rendered descendants so disclosure and density changes resize the content.
  const heightOf = (node: ReactTestInstance): number => {
    if (node.props["data-thread-relationships-panel"] !== undefined) return 160;
    if (node.type === "button") return 40;
    return (
      (node.type === "section" ? 24 : 0) +
      node.children.reduce(
        (sum, child) => sum + (typeof child === "string" ? 0 : heightOf(child)),
        0,
      )
    );
  };
  const querySelectorAll = (selector: string) =>
    renderer.root
      .findAll(
        (node) =>
          typeof node.type === "string" &&
          selector.split(",").some((part) => node.props[part.trim().slice(1, -1)] !== undefined),
      )
      .map((node) => ({ offsetHeight: heightOf(node) }));
  const props: ThreadDetailsPanelProps = {
    ...threadRef,
    anchor: { current: null },
    handle: PopoverCreateHandle(),
    onPresentationChange: vi.fn(),
    activeProjectName: undefined,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    showOpenInPicker: true,
    gitCwd: "/tmp/thread-details-project",
    isGitRepo: true,
    envLocked: false,
    availableEnvironments: [],
    onEnvironmentChange: vi.fn(),
    onEnvModeChange: vi.fn(),
    envMode: "local",
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    onComposerFocusRequest: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn(),
    onUpdateProjectScript: vi.fn(),
    onDeleteProjectScript: vi.fn(),
  };
  const button = (label: string) =>
    renderer.root.findAllByType("button").find((node) => node.children.includes(label));
  const workspaceControls = () =>
    ["Machine", "Project", "Open in…"].filter((label) => button(label) !== undefined);
  const toggle = async (label: string) => {
    const control = button(label);
    expect(control).toBeDefined();
    await act(() => control!.props.onClick());
    await act(() => {
      for (const callback of Array.from(resize.callbacks)) callback();
    });
  };
  try {
    await act(() => {
      renderer = create(<ThreadDetailsPanel {...props} />, {
        createNodeMock: (element) =>
          element.type === "div"
            ? {
                get offsetHeight() {
                  return heightOf(renderer.root);
                },
                closest: () => null,
                querySelectorAll,
                querySelector: (selector: string) => querySelectorAll(selector)[0] ?? null,
              }
            : null,
      });
    });
    expect(workspaceControls()).toEqual(["Machine", "Project", "Open in…"]);
    await toggle("Show 69 more");
    expect(
      renderer.root.findAllByType("button").filter((node) => node.children[0] === "Pull request #"),
    ).toHaveLength(70);
    await toggle("Show less");
    expect(button("Show 69 more")).toBeDefined();
    expect(workspaceControls()).toEqual(["Machine", "Project", "Open in…"]);
  } finally {
    await act(() => renderer?.unmount());
    resize.callbacks.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
