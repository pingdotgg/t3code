import type { EnvironmentId, T3ProjectFileScript, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  branchToolbar: vi.fn(),
  useClientSettings: vi.fn(),
  useUpdateClientSettings: vi.fn(),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector?: (settings: unknown) => unknown) =>
    testState.useClientSettings(selector),
  useUpdateClientSettings: () => testState.useUpdateClientSettings(),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: (props: unknown) => {
    testState.branchToolbar(props);
    return null;
  },
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

const baseProps: ThreadDetailsPanelProps = {
  mode: "popover",
  environmentId: "environment:thread-details" as EnvironmentId,
  threadId: "thread:thread-details" as ThreadId,
  activeProjectName: "Project",
  activeProjectScripts: undefined,
  preferredScriptId: null,
  keybindings: [],
  availableEditors: [],
  showOpenInPicker: false,
  gitCwd: "/tmp/thread-details-project",
  isGitRepo: true,
  envLocked: false,
  availableEnvironments: [],
  onEnvironmentChange: vi.fn(),
  onEnvModeChange: vi.fn(),
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

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
    testState.branchToolbar.mockReset();
    testState.useUpdateClientSettings.mockReset();
    testState.useClientSettings.mockReset();
    testState.useClientSettings.mockImplementation(
      (selector?: (settings: Record<string, unknown>) => unknown) =>
        selector?.({ threadDetailsSections: { sections: {} } }) ?? {
          threadDetailsSections: { sections: {} },
        },
    );
    testState.useUpdateClientSettings.mockReturnValue(Promise.resolve({}));
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

    const props: ThreadDetailsPanelProps = {
      mode: "popover",
      environmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
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

  it("renders every default section by default", () => {
    const markup = renderToStaticMarkup(<ThreadDetailsPanel {...baseProps} />);
    expect(markup).toContain("Workspace");
    expect(markup).toContain("Version Control");
    expect(markup).toContain("Customize thread details");
  });

  it("hides a section set to hidden", () => {
    testState.useClientSettings.mockImplementation(
      (selector?: (settings: Record<string, unknown>) => unknown) =>
        selector?.({
          threadDetailsSections: {
            sections: { "version-control": { visibility: "hidden" } },
          },
        }) ?? {},
    );
    const markup = renderToStaticMarkup(<ThreadDetailsPanel {...baseProps} />);
    expect(markup).toContain("Workspace");
    expect(markup).not.toContain("Version Control");
  });

  it("hides an item set to hidden while keeping its section", () => {
    testState.useClientSettings.mockImplementation(
      (selector?: (settings: Record<string, unknown>) => unknown) =>
        selector?.({
          threadDetailsSections: {
            sections: { workspace: { items: { branch: false } } },
          },
        }) ?? {},
    );
    renderToStaticMarkup(<ThreadDetailsPanel {...baseProps} />);
    const workspaceToolbars = testState.branchToolbar.mock.calls.filter(
      (call) => (call[0] as { panelSection: string }).panelSection === "workspace",
    );
    expect(workspaceToolbars).toHaveLength(0);
  });

  it("shows the empty state for an always section without content", () => {
    testState.useClientSettings.mockImplementation(
      (selector?: (settings: Record<string, unknown>) => unknown) =>
        selector?.({
          threadDetailsSections: {
            sections: { "version-control": { visibility: "always" } },
          },
        }) ?? {},
    );
    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel {...baseProps} isGitRepo={false} activeProjectName={undefined} />,
    );
    expect(markup).toContain("Version Control");
    expect(markup).toContain("Version control unavailable.");
  });

  it("offers a way back when every section is hidden", () => {
    testState.useClientSettings.mockImplementation(
      (selector?: (settings: Record<string, unknown>) => unknown) =>
        selector?.({
          threadDetailsSections: {
            sections: {
              workspace: { visibility: "hidden" },
              "version-control": { visibility: "hidden" },
              automations: { visibility: "hidden" },
              relationships: { visibility: "hidden" },
            },
          },
        }) ?? {},
    );
    const markup = renderToStaticMarkup(<ThreadDetailsPanel {...baseProps} />);
    expect(markup).toContain("No details to show.");
    expect(markup).toContain("Customize");
  });
});
