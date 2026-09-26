import type { EnvironmentId, T3ProjectFileScript, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { PopoverCreateHandle } from "../ui/popover";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  sections: { sections: {} } as import("@t3tools/contracts").ThreadDetailsSectionsSetting,
  density: "full" as "full" | "compact" | "essential",
  updateSettings: vi.fn(),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: unknown) => unknown) =>
    selector({ threadDetailsSections: testState.sections }),
  useUpdateClientSettings: () => testState.updateSettings,
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => <section>Automations</section>,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => <section>Lineage</section>,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({
    children,
  }: Pick<
    React.ComponentProps<typeof import("./ThreadDetailsCard").ThreadDetailsCard>,
    "children"
  >) =>
    children(testState.density, (content, action) => (
      <>
        {action}
        {content}
      </>
    )),
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, onClick }: ComponentProps<"button">) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("./ThreadDetailsCustomize", () => ({
  ThreadDetailsCustomizeButton: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Customize</button>
  ),
  ThreadDetailsEditor: (
    props: ComponentProps<typeof import("./ThreadDetailsCustomize").ThreadDetailsEditor>,
  ) => (
    <>
      <span>{JSON.stringify(props.sections)}</span>
      <button onClick={() => props.onChange({ sections: { workspace: { visibility: "hidden" } } })}>
        Hide workspace
      </button>
      <button onClick={props.onCancel}>Cancel</button>
      <button onClick={props.onDone}>Done</button>
      <button onClick={props.onReset}>Reset</button>
    </>
  ),
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
    testState.sections = { sections: {} };
    testState.density = "full";
    testState.updateSettings.mockReset();
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props = { ...baseProps, environmentId, gitCwd };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });
});

const baseProps: ThreadDetailsPanelProps = {
  anchor: { current: null },
  handle: PopoverCreateHandle(),
  onPresentationChange: vi.fn(),
  environmentId: "environment:thread-details" as EnvironmentId,
  threadId: "thread:thread-details" as ThreadId,
  activeProjectName: undefined,
  activeProjectScripts: [],
  preferredScriptId: null,
  keybindings: [],
  availableEditors: [],
  showOpenInPicker: false,
  gitCwd: "/tmp/thread-details-project",
  isGitRepo: false,
  envLocked: false,
  availableEnvironments: [],
  onEnvironmentChange: vi.fn(),
  onEnvModeChange: vi.fn(),
  envMode: "local",
  startFromOrigin: false,
  onStartFromOriginChange: vi.fn(),
  onComposerFocusRequest: vi.fn(),
  versionMismatch: null,
  onDismissVersionMismatch: vi.fn(),
  onRunProjectScript: vi.fn(),
  onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
  onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
  onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
};

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
function renderPanel(props = baseProps) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(<ThreadDetailsPanel {...props} />);
  });
}
function click(label: string) {
  act(() => {
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes(label))!
      .props.onClick();
  });
}
function text() {
  return JSON.stringify(renderer.toJSON());
}

it("keeps staged edits when the customization command fires again and saves once", () => {
  testState.sections = { sections: {} };
  testState.updateSettings.mockReset();
  renderPanel();
  click("Customize");
  click("Hide workspace");
  expect(testState.updateSettings).not.toHaveBeenCalled();
  act(() => renderer.update(<ThreadDetailsPanel {...baseProps} customizeRequested />));
  click("Done");
  expect(testState.updateSettings).toHaveBeenCalledExactlyOnceWith({
    threadDetailsSections: { sections: { workspace: { visibility: "hidden" } } },
  });
});

it("discards a staged change on Cancel and stages Reset until Done", () => {
  testState.sections = { sections: {} };
  testState.updateSettings.mockReset();
  renderPanel();
  click("Customize");
  click("Hide workspace");
  click("Cancel");
  expect(testState.updateSettings).not.toHaveBeenCalled();
  click("Customize");
  click("Reset");
  expect(testState.updateSettings).not.toHaveBeenCalled();
  click("Done");
  expect(testState.updateSettings).toHaveBeenCalledExactlyOnceWith({
    threadDetailsSections: { sections: {} },
  });
});

it("folds Auto sections at essential density while keeping Always sections", () => {
  testState.sections = { sections: {} };
  testState.density = "essential";
  const props = { ...baseProps, activeProjectScripts: undefined };
  renderPanel(props);
  expect(text()).not.toContain("Workspace");
  expect(text()).not.toContain("Automations");
  expect(text()).not.toContain("Lineage");
  testState.sections = {
    sections: {
      workspace: { visibility: "always" },
      automations: { visibility: "always" },
      relationships: { visibility: "always" },
    },
  };
  act(() => renderer.update(<ThreadDetailsPanel {...props} />));
  expect(text()).toContain("Workspace");
  expect(text()).toContain("Automations");
  expect(text()).toContain("Lineage");
});

it("keeps a recovery button and version warning when all sections are hidden", () => {
  testState.sections = {
    sections: {
      workspace: { visibility: "hidden" },
      "version-control": { visibility: "hidden" },
      automations: { visibility: "hidden" },
      relationships: { visibility: "hidden" },
    },
  };
  renderPanel({
    ...baseProps,
    versionMismatch: { clientVersion: "1", serverVersion: "2", serverLabel: "Server" },
  });
  expect(text()).toContain("No details to show.");
  expect(text()).toContain("Client and server versions differ");
  click("Customize");
  expect(text()).toContain("Hide workspace");
});
