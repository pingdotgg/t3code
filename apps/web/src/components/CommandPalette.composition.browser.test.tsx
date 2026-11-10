import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import { act, render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

const addProject = vi.hoisted(() => ({
  inspection: undefined as unknown,
  createdRoots: [] as string[],
  createGate: Promise.resolve(),
  projects: [] as ReadonlyArray<unknown>,
  openedProjectIds: [] as string[],
}));
const scopes = vi.hoisted(() => ({ denied: undefined as string | undefined }));
const setup = (deniedScope?: string) => {
  scopes.denied = deniedScope;
};

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
}));
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "t3-chat", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateEnvironmentSettings: () => () => undefined,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => null,
    scratchWorkspaceRootFor: () => null,
  }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: async (ref: { readonly projectId: string }) => {
      addProject.openedProjectIds.push(ref.projectId);
    },
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async (args?: { input?: { workspaceRoot?: string } }) => {
    if (args?.input?.workspaceRoot !== undefined) {
      addProject.createdRoots.push(args.input.workspaceRoot);
      await addProject.createGate;
    }
    return { _tag: "Success", value: undefined };
  },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async (args?: { input?: { path?: string } }) => ({
    _tag: "Success",
    value: args?.input?.path === undefined ? undefined : addProject.inspection,
  }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "Local",
        connection: { phase: "connected" },
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: {
          environment: {
            platform: { os: "linux" },
            capabilities: { projectCloneTracking: true, projectCheckoutInspection: true },
          },
          settings: { addProjectBaseDirectory: "/workspace/" },
          newProjectsRoot: "/workspace/",
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => addProject.projects,
  useThreadShells: () => [],
  useVisibleThreadShells: () => [],
  useHiddenThreadKeys: () => new Set(),
  useAnyEnvironmentHiding: () => false,
  useEnvironmentThreadRefs: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: async () => undefined,
}));
vi.mock("../state/queries", async (original) => ({
  ...(await original<typeof import("../state/queries")>()),
  useThreadSearch: (_environmentIds: unknown, query: string) => ({
    matches: [],
    query,
    isPending: false,
  }),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: (_environmentId: unknown, scope: string) => scope !== scopes.denied,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/filesystem", async (original) => ({
  ...(await original<typeof import("../state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

// The real palette and Base UI input must agree that confirming composition is typing.
describe.each(["repository", "folder", "destination"] as const)("add-project %s", (step) => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("keeps Enter in the input during composition: %j", async (composition) => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(step === "folder" ? "Local folder" : "Git URL", { exact: true }).click();
    const input = () => page.getByRole("combobox");
    if (step === "destination") {
      await input().fill("https://example.com/team/project.git");
      await userEvent.keyboard("{Enter}");
    }
    const value = step === "repository" ? "https://example.com/team/計画.git" : "/workspace/計画";
    await input().fill(value);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    await act(() => input().element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(input()).toHaveValue(value);
    if (step === "repository") {
      await userEvent.keyboard("{Enter}");
      await expect.element(input()).toHaveValue("/workspace/計画");
    } else {
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    }
  });
});

it.each([
  { step: "folder", source: "Local folder", keys: "", description: /^(?!.*(Ctrl|⌘)).*Add.*Enter/ },
  {
    step: "highlighted folder",
    source: "Local folder",
    keys: "{ArrowDown}",
    description: /Add.*(Ctrl|⌘) Enter/,
  },
  { step: "repository", source: "Git URL", keys: "", description: /Continue.*Enter/ },
  { step: "new project", source: "New project", keys: "", description: /Create.*Enter/ },
  {
    step: "permission-blocked folder",
    source: "Local folder",
    keys: "",
    deniedScope: AuthOrchestrationOperateScope,
    description: "This connection cannot add projects.",
  },
  {
    step: "permission-blocked destination",
    source: "Git URL",
    keys: "https://example.com/team/project.git{Enter}",
    deniedScope: AuthSourceControlWriteScope,
    description: "This connection needs permission to write source control and add projects.",
  },
])(
  "tells screen readers how to submit the $step step",
  async ({ source, keys, deniedScope, description }) => {
    setup(deniedScope);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(source, { exact: true }).click();
    if (keys) await userEvent.keyboard(keys);
    await expect.element(page.getByRole("combobox")).toHaveAccessibleDescription(description);
  },
);

it("keeps the caret in place when an edit briefly makes the folder path not a path", async () => {
  setup();
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("Local folder", { exact: true }).click();
  const input = () => page.getByRole("combobox");
  await input().fill("/workspace/project");
  await userEvent.keyboard("{Home}{ArrowRight}{Backspace}");
  await expect.element(input()).toHaveValue("workspace/project");
  await userEvent.keyboard("/");
  await expect.element(input()).toHaveValue("/workspace/project");
  await userEvent.keyboard("w");
  await expect.element(input()).toHaveValue("/wworkspace/project");
});

describe("add-project checkout choice", () => {
  async function showChoices(input: {
    readonly rootProjectId: string | null;
    readonly projects: typeof addProject.projects;
  }) {
    let finishCreate = () => {};
    addProject.createGate = new Promise((resolve) => {
      finishCreate = resolve;
    });
    addProject.createdRoots = [];
    addProject.openedProjectIds = [];
    addProject.projects = input.projects;
    addProject.inspection = {
      projectId: null,
      checkout: {
        selectedPath: "/workspace/repo/apps",
        root: "/workspace/repo",
        rootProjectId: input.rootProjectId,
        branch: "main",
        isLinkedWorktree: false,
      },
    };
    const screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText("Local folder", { exact: true }).click();
    await page.getByRole("combobox").fill("/workspace/repo/apps");
    await userEvent.keyboard("{Enter}");
    return {
      finishCreate: () => act(() => finishCreate()),
      async [Symbol.asyncDispose]() {
        await screen[Symbol.asyncDispose]();
        addProject.inspection = undefined;
        addProject.createGate = Promise.resolve();
        addProject.projects = [];
      },
    };
  }

  it("sends one create when chosen again while the first is pending", async () => {
    await using choices = await showChoices({ rootProjectId: null, projects: [] });

    const addRoot = page.getByText("Add repository root", { exact: true });
    await addRoot.click();
    await addRoot.click();
    await choices.finishCreate();

    expect(addProject.createdRoots).toEqual(["/workspace/repo"]);
  });

  it("does not open the root project while an add is pending", async () => {
    await using choices = await showChoices({
      rootProjectId: "root-project",
      projects: [
        {
          id: "root-project",
          environmentId: "local",
          title: "Root",
          workspaceRoot: "/workspace/repo",
          archivedAt: null,
        },
      ],
    });

    await page.getByText("Add selected folder", { exact: true }).click();
    await page.getByText("Open Root", { exact: true }).click();
    await choices.finishCreate();

    expect(addProject.createdRoots).toEqual(["/workspace/repo/apps"]);
    expect(addProject.openedProjectIds).not.toContain("root-project");
  });
});

it.each([
  { flow: "Git URL", value: "https://github.com/pingdotgg/t3code.git", submit: "Continue (Enter)" },
  { flow: "New project", value: "demo-tab-order", submit: /^Create \(/ },
])("moves focus from the $flow input to its enabled submit button on Tab", async (step) => {
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText(step.flow, { exact: true }).click();
  const input = page.getByRole("combobox");
  await input.fill(step.value);
  const submit = page.getByRole("button", { name: step.submit });
  await expect.element(submit).toBeEnabled();
  await userEvent.keyboard("{Tab}");
  await expect.element(submit).toHaveFocus();
});
