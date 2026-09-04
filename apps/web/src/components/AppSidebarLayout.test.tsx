import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  pathname: "/",
  threadSidebarProps: null as {
    projectScopeKey: string | null;
    onProjectScopeKeyChange: (projectScopeKey: string | null) => void;
  } | null,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: mocks.pathname }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => null,
  removeLocalStorageItem: vi.fn(),
}));
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useLegacySidebarEnabled: () => false,
}));
vi.mock("../keybindings", () => ({
  resolveShortcutCommand: () => null,
  shortcutLabelForCommand: () => null,
}));
vi.mock("../lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
  isMacPlatform: () => false,
}));
vi.mock("../panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
}));
vi.mock("../state/entities", () => ({ useProjects: vi.fn() }));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("./LegacySidebar", () => ({ default: () => null }));
vi.mock("./Sidebar", () => ({
  default: (props: NonNullable<typeof mocks.threadSidebarProps>) => {
    mocks.threadSidebarProps = props;
    return null;
  },
}));
vi.mock("./settings/SettingsSidebarNav", () => ({ SettingsSidebarNav: () => null }));
vi.mock("./sidebar/SidebarChrome", () => ({ SidebarChromeHeader: () => null }));
vi.mock("./SidebarStageBackdrop", () => ({
  resolveSidebarStageFocusRingOffsetClass: () => "",
  useSidebarStageBackdropVariant: () => null,
}));
vi.mock("./threadSidebarWidth", () => ({
  resolveInitialThreadSidebarWidth: () => 320,
  resolveThreadSidebarMaximumWidth: () => 640,
  THREAD_MAIN_CONTENT_MIN_WIDTH: 320,
  THREAD_SIDEBAR_MIN_WIDTH: 240,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY: "test-sidebar-width",
}));
vi.mock("./ui/sidebar", () => ({
  Sidebar: ({ children }: { children: ReactNode }) => children,
  SidebarProvider: ({ children }: { children: ReactNode }) => children,
  SidebarRail: () => null,
  SidebarTrigger: () => null,
  useSidebar: () => ({ toggleSidebar: vi.fn() }),
  useSidebarVisibility: () => true,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));

import { AppSidebarLayout } from "./AppSidebarLayout";

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  nodeValue: string | null = null;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  createTextNode(value: string) {
    const node = new TestNode("#text", this, 3);
    node.nodeValue = value;
    return node;
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    innerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("navigator", { platform: "test", userAgent: "test" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

afterEach(() => {
  mocks.pathname = "/";
  mocks.threadSidebarProps = null;
  vi.unstubAllGlobals();
});

describe("AppSidebarLayout", () => {
  it("keeps the selected project when the thread sidebar unmounts for settings", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.createElement("div") as unknown as Element);
    const renderLayout = () => root.render(<AppSidebarLayout>{null}</AppSidebarLayout>);

    try {
      await act(renderLayout);
      expect(mocks.threadSidebarProps?.projectScopeKey).toBeNull();

      await act(() => mocks.threadSidebarProps?.onProjectScopeKeyChange("project-2"));
      expect(mocks.threadSidebarProps?.projectScopeKey).toBe("project-2");

      mocks.pathname = "/settings/general";
      await act(renderLayout);

      mocks.pathname = "/";
      await act(renderLayout);
      expect(mocks.threadSidebarProps?.projectScopeKey).toBe("project-2");
    } finally {
      await act(() => root.unmount());
    }
  });
});
