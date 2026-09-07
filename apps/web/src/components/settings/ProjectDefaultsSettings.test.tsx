import type { ReactElement } from "react";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" | "disconnected" };
    serverConfig: { settings: ServerSettings; providers: [] } | null;
  }>,
  projects: [] as Array<{
    environmentId: EnvironmentId;
    id: ProjectId;
    title: string;
    defaultModelSelection: ModelSelection | null;
  }>,
  confirm: vi.fn<() => Promise<boolean>>(),
  updateProject: vi.fn(),
  updateSettings: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: "update-project" } }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { updateSettings: "update-settings" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "update-project" ? state.updateProject : state.updateSettings,
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("./ProjectSettingsPanel", () => ({ PROJECT_GROUPING_MODE_LABELS: {} }));
vi.mock("./ProjectDefaultActionsSettings", () => ({ ProjectDefaultActionsSettings: () => null }));

import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");
const offline = EnvironmentId.make("offline");
const unavailable = EnvironmentId.make("unavailable");
const override: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-model",
};

/** Builds a physical project fixture, allowing the same project ID on different machines. */
function project(environmentId: EnvironmentId, id: string, inherits = false) {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    defaultModelSelection: inherits ? null : override,
  };
}

/** Renders the scoped reset control while retaining hook state across simulated rerenders. */
function resetButton(environmentId: EnvironmentId | null = null) {
  hooks.beginRender();
  const panel = ProjectDefaultsSettings({ environmentId });
  const row = visitElements(panel, (element) => element.props.title === "Project model overrides");
  return row!.props.control as ReactElement<{ disabled: boolean; onClick: () => Promise<void> }>;
}

beforeEach(() => {
  hooks.reset();
  state.environments = [laptop, desktop, offline, unavailable].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: environmentId === offline ? "disconnected" : "connected" },
    serverConfig:
      environmentId === unavailable
        ? null
        : {
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              defaultModelSelection: { ...override, model: `${environmentId}-default` },
            },
            providers: [],
          },
  }));
  state.projects = [
    project(laptop, "shared-id"),
    project(laptop, "already-inherits", true),
    project(desktop, "shared-id"),
    project(offline, "offline-project"),
    project(unavailable, "unavailable-project"),
  ];
  state.confirm.mockReset().mockResolvedValue(true);
  state.updateProject.mockReset().mockResolvedValue({ _tag: "Success" });
  state.updateSettings.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toast.mockReset();
});

describe("reset project model overrides", () => {
  it("only resets overrides on the selected machine, even when project IDs are shared", async () => {
    await resetButton(laptop).props.onClick();

    expect(state.updateProject.mock.calls).toEqual([
      [
        {
          environmentId: laptop,
          input: { projectId: ProjectId.make("shared-id"), defaultModelSelection: null },
        },
      ],
    ]);
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining("1 project model override on laptop?"),
    );
  });

  it("resets all connected machines to inheritance and reports skipped machines", async () => {
    await resetButton().props.onClick();

    expect(state.updateProject.mock.calls).toEqual([
      [
        {
          environmentId: laptop,
          input: { projectId: ProjectId.make("shared-id"), defaultModelSelection: null },
        },
      ],
      [
        {
          environmentId: desktop,
          input: { projectId: ProjectId.make("shared-id"), defaultModelSelection: null },
        },
      ],
    ]);
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining("inherit later changes"));
    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining("skipped: offline, unavailable"),
    );
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        description: expect.stringContaining(
          "2 project model overrides reset. Existing threads are unchanged.",
        ),
      }),
    );
  });

  it("requires confirmation and releases the pending guard after cancellation", async () => {
    let finishConfirmation!: (confirmed: boolean) => void;
    state.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishConfirmation = resolve;
        }),
    );
    const button = resetButton();
    const pending = button.props.onClick();
    expect(resetButton().props.disabled).toBe(true);
    await button.props.onClick();
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.updateProject).not.toHaveBeenCalled();

    finishConfirmation(false);
    await pending;
    expect(resetButton().props.disabled).toBe(false);
    expect(state.updateProject).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("continues after a failure and retries only overrides that remain", async () => {
    state.projects.push(project(desktop, "another-checkout"));
    state.updateProject.mockImplementation(async ({ environmentId, input }) => {
      if (environmentId === laptop) return { _tag: "Failure" };
      state.projects = state.projects.map((project) =>
        project.environmentId === environmentId && project.id === input.projectId
          ? { ...project, defaultModelSelection: input.defaultModelSelection }
          : project,
      );
      return { _tag: "Success" };
    });
    await resetButton().props.onClick();

    expect(state.updateProject).toHaveBeenCalledTimes(3);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: expect.stringContaining(
          "2 project model overrides reset. Existing threads are unchanged. Could not reset shared-id (laptop).",
        ),
      }),
    );
    state.updateProject.mockClear().mockResolvedValue({ _tag: "Success" });
    await resetButton().props.onClick();
    expect(state.updateProject).toHaveBeenCalledTimes(1);
    expect(state.updateProject).toHaveBeenCalledWith({
      environmentId: laptop,
      input: { projectId: ProjectId.make("shared-id"), defaultModelSelection: null },
    });
  });

  it("does not offer a reset when no connected projects have overrides", async () => {
    expect(resetButton(offline).props.disabled).toBe(true);
    await resetButton(offline).props.onClick();
    state.projects = state.projects.map((project) => ({ ...project, defaultModelSelection: null }));
    expect(resetButton().props.disabled).toBe(true);
    await resetButton().props.onClick();
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.updateProject).not.toHaveBeenCalled();
  });
});
