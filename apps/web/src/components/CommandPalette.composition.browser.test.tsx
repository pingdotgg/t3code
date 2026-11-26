import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act, fakeTimers, render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { dispatchCommandPalette } from "../commandPaletteStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { toastManager } from "./ui/toast";

const scopes = vi.hoisted(() => ({
  denied: undefined as string | undefined,
  sourceControl: undefined as unknown,
  waitForProject: vi.fn<(ref: ScopedProjectRef) => Promise<EnvironmentProject | undefined>>(),
  projectCommand: vi.fn<() => Promise<{ _tag: "Success"; value: { projectId: string } }>>(),
}));
const setup = (deniedScope?: string, sourceControl?: unknown) => {
  scopes.denied = deniedScope;
  scopes.sourceControl = sourceControl;
  scopes.waitForProject.mockReset().mockResolvedValue(undefined);
  scopes.projectCommand
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { projectId: "project-cloned" } });
};
const githubAvailable = {
  versionControlSystems: [],
  sourceControlProviders: [
    {
      kind: "github",
      label: "GitHub",
      status: "available",
      version: { _tag: "None" },
      installHint: "Install GitHub CLI",
      detail: { _tag: "None" },
      auth: {
        status: "authenticated",
        account: { _tag: "Some", value: "demo" },
        host: { _tag: "None" },
        detail: { _tag: "None" },
      },
    },
  ],
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
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: async () => undefined,
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  // The add-project destination step starts a clone and follows its project id.
  useAtomCommand: () => scopes.projectCommand,
}));
vi.mock("../state/use-atom-query-runner", () => ({
  // Doubles as the add-project folder scan, which finds nothing to track.
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: { folders: [] } }),
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
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
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
  useProjects: () => [],
  useThreadShells: () => [],
  useVisibleThreadShells: () => [],
  useHiddenThreadKeys: () => new Set(),
  useAnyEnvironmentHiding: () => false,
  useEnvironmentThreadRefs: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: (ref: ScopedProjectRef) => scopes.waitForProject(ref),
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
  useEnvironmentQuery: () => ({ data: scopes.sourceControl, isLoading: false }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

it.each(["dismissed", "backed out of", "timed out"] as const)(
  "keeps the current draft project when a pending folder add is %s",
  async (outcome) => {
    setup();
    const update = Promise.withResolvers<EnvironmentProject>();
    const waiting = Promise.withResolvers<void>();
    scopes.waitForProject.mockImplementationOnce(() => {
      waiting.resolve();
      return update.promise;
    });
    const draftId = DraftId.make(`pending-folder-add-${outcome}`);
    const environmentId = EnvironmentId.make("local");
    const original = { environmentId, projectId: ProjectId.make("original") };
    const newer = { environmentId, projectId: ProjectId.make("newer") };
    const folder = `/workspace/${draftId}`;
    const project = (projectId: ProjectId, workspaceRoot = folder): EnvironmentProject => ({
      environmentId,
      id: projectId,
      title: "added",
      workspaceRoot,
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      scripts: [],
    });
    const draftStore = useComposerDraftStore.getState();
    draftStore.setProjectDraftThreadId(original, draftId);
    draftStore.setPrompt(draftId, "Keep this draft");

    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    using toast = vi.spyOn(toastManager, "add");
    await act(() => openCommandPalette({ open: "add-project", draftId }));
    const submitFolder = async (path: string) => {
      await page.getByText("Local folder", { exact: true }).click();
      await page.getByRole("combobox").fill(path);
      await userEvent.keyboard("{Enter}");
    };
    await submitFolder(folder);
    await waiting.promise;
    const [firstRef] = scopes.waitForProject.mock.calls[0]!;

    if (outcome === "dismissed") {
      await act(() => {
        dispatchCommandPalette({ _tag: "SetOpen", open: false });
        draftStore.setProjectDraftThreadId(newer, draftId);
        openCommandPalette({ open: "new-thread-in" });
        update.resolve(project(firstRef.projectId));
      });
      await expect.element(page.getByRole("combobox")).toBeInTheDocument();
      expect(draftStore.getDraftSession(draftId)?.projectId).toBe(newer.projectId);
    } else if (outcome === "backed out of") {
      await page.getByRole("combobox").fill("");
      const nextUpdate = Promise.withResolvers<EnvironmentProject>();
      scopes.waitForProject.mockReturnValueOnce(nextUpdate.promise);
      const nextFolder = `${folder}-next`;
      await submitFolder(nextFolder);
      expect(scopes.waitForProject).toHaveBeenCalledTimes(2);
      const [nextRef] = scopes.waitForProject.mock.calls[1]!;
      await act(() => update.resolve(project(firstRef.projectId)));
      await expect.element(page.getByRole("combobox")).toHaveValue(nextFolder);
      expect(draftStore.getDraftSession(draftId)?.projectId).toBe(original.projectId);
      await userEvent.keyboard("{Enter}");
      expect(scopes.waitForProject).toHaveBeenCalledTimes(2);
      await act(() => nextUpdate.resolve(project(nextRef.projectId, nextFolder)));
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
      expect(draftStore.getDraftSession(draftId)?.projectId).toBe(nextRef.projectId);
    } else {
      await userEvent.keyboard("{Enter}");
      expect(scopes.waitForProject).toHaveBeenCalledTimes(1);
      await act(() => update.reject(new Error("The project did not appear in the desktop app.")));
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Failed to open project",
          description: expect.stringContaining("It will appear in the sidebar"),
        }),
      );
      expect(draftStore.getDraftSession(draftId)?.projectId).toBe(original.projectId);
      scopes.waitForProject.mockResolvedValueOnce(project(firstRef.projectId));
      await act(() => openCommandPalette({ open: "add-project", draftId }));
      await submitFolder(folder);
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
      expect(scopes.waitForProject).toHaveBeenNthCalledWith(2, firstRef);
      expect(draftStore.getDraftSession(draftId)?.projectId).toBe(firstRef.projectId);
    }
    expect(draftStore.getComposerDraft(draftId)?.prompt).toBe("Keep this draft");
  },
);

it.each(["replaced", "expired"] as const)(
  "resubmits a folder when its earlier add was %s",
  async (outcome) => {
    setup();
    const result = { _tag: "Success" as const, value: { projectId: "created" } };
    const reply = Promise.withResolvers<typeof result>();
    scopes.projectCommand.mockReturnValueOnce(reply.promise);
    scopes.waitForProject.mockRejectedValue(new Error("Project has not reached this client."));
    const draftId = DraftId.make(`resubmitted-folder-add-${outcome}`);
    const folder = `/workspace/${draftId}`;
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    const openAdd = () => act(() => openCommandPalette({ open: "add-project", draftId }));
    const submitFolder = async () => {
      await page.getByText("Local folder", { exact: true }).click();
      await page.getByRole("combobox").fill(folder);
      await userEvent.keyboard("{Enter}");
    };
    await openAdd();
    await submitFolder();
    expect(scopes.projectCommand).toHaveBeenCalledTimes(1);

    if (outcome === "replaced") {
      await page.getByRole("combobox").fill("");
      await submitFolder();
      expect(scopes.projectCommand).toHaveBeenCalledTimes(1);
      await act(() => reply.resolve(result));
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
      expect(scopes.waitForProject).toHaveBeenCalledTimes(1);
    } else {
      {
        using _timers = fakeTimers();
        await act(() => reply.resolve(result));
        await act(() => vi.advanceTimersByTime(60_000));
      }
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
      await openAdd();
      await submitFolder();
      expect(scopes.projectCommand).toHaveBeenCalledTimes(2);
    }
  },
);

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

it("tells screen readers whether a new project will be published", async () => {
  setup(undefined, githubAvailable);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("New project", { exact: true }).click();
  await page.getByRole("combobox").fill("demo-project");
  const option = page.getByRole("option", { name: /Create private repository/ });
  await expect.element(option).toHaveAttribute("aria-checked", "false");
  await option.click();
  await expect.element(option).toHaveAttribute("aria-checked", "true");
});
