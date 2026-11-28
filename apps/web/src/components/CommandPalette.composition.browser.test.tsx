import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act, render, stubGlobal } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { moveDraftToProject } from "../lib/moveDraftToProject";
import { primaryServerKeybindingsAtom } from "../state/server";
import { projectEnvironment } from "../state/projects";
import { sourceControlEnvironment } from "../state/sourceControl";
import { AsyncResult } from "effect/reactivity";

const createdProject = {
  _tag: "Success",
  value: { projectId: "project-created", workspaceRoot: "/workspace/new-project" },
} as const;

const scopes = vi.hoisted(() => ({
  denied: undefined as string | undefined,
  sourceControl: undefined as unknown,
  isBrowsePending: false,
  lookupRepository: vi.fn(),
  createNewProject: vi.fn<() => Promise<typeof createdProject>>(),
  openDraft: vi.fn<() => Promise<void>>(),
  addProject: vi.fn<() => Promise<{ _tag: "Success"; value: { projectId: string } }>>(),
  waitForProject: vi.fn<() => Promise<EnvironmentProject | undefined>>(),
}));
const setup = (deniedScope?: string, sourceControl?: unknown, isBrowsePending = false) => {
  scopes.denied = deniedScope;
  scopes.sourceControl = sourceControl;
  scopes.createNewProject.mockReset().mockResolvedValue(createdProject);
  scopes.openDraft.mockReset().mockResolvedValue(undefined);
  scopes.addProject.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { projectId: "project-cloned" },
  });
  scopes.isBrowsePending = isBrowsePending;
  scopes.waitForProject.mockReset().mockResolvedValue(undefined);
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
vi.mock("../hooks/useTheme", async (original) => ({
  ...(await original<typeof import("../hooks/useTheme")>()),
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
    scratchUnavailableReason: () => null,
  }),
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: scopes.openDraft,
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  // The add-project destination step starts a clone and follows its project id.
  useAtomCommand: (command: unknown) =>
    command === projectEnvironment.createNew
      ? scopes.createNewProject
      : command === projectEnvironment.create
        ? scopes.addProject
        : async () => ({ _tag: "Success", value: { projectId: "project-cloned" } }),
}));
vi.mock("../state/use-atom-query-runner", () => ({
  // Doubles as the add-project folder scan, which finds nothing to track.
  useAtomQueryRunner: (family: unknown) =>
    family === sourceControlEnvironment.repository
      ? scopes.lookupRepository
      : async () => ({ _tag: "Success", value: { folders: [] } }),
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
  waitForProject: scopes.waitForProject,
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
  useEnvironmentQuery: () => ({
    data: scopes.sourceControl,
    isLoading: false,
    isPending: scopes.isBrowsePending,
  }),
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
  { isBrowsePending: false, leavesInput: true },
  { isBrowsePending: true, leavesInput: false },
])(
  "Tab with nothing to complete in the folder path: %j",
  async ({ isBrowsePending, leavesInput }) => {
    setup(undefined, undefined, isBrowsePending);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText("Local folder", { exact: true }).click();
    const input = page.getByRole("combobox");
    await input.fill("/workspace/zzz");
    await userEvent.keyboard("{Tab}");
    if (leavesInput) {
      await expect.element(input).not.toHaveFocus();
      expect(page.getByRole("dialog").element().contains(document.activeElement)).toBe(true);
    } else await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("/workspace/zzz");
  },
);

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
  setup();
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

async function submitProjectAdd(source: string, input: string, draftId?: DraftId) {
  await act(() => openCommandPalette({ open: "add-project", ...(draftId && { draftId }) }));
  await page.getByText(source, { exact: true }).click();
  await page.getByRole("combobox").fill(input);
  await userEvent.keyboard("{Enter}");
}

async function startLateProjectAdd(source: string, input: string, draftId?: DraftId) {
  const finished = Promise.withResolvers<void>();
  const created = Promise.withResolvers<typeof createdProject>();
  scopes.createNewProject.mockReturnValue(created.promise);
  scopes.openDraft.mockReturnValue(finished.promise);
  scopes.addProject.mockImplementation(async () => {
    await finished.promise;
    return { _tag: "Success", value: { projectId: "project-added" } };
  });
  await submitProjectAdd(source, input, draftId);
  return async () => {
    await act(async () => {
      created.resolve(createdProject);
      finished.resolve();
      await finished.promise;
    });
    expect(source === "New project" ? scopes.openDraft : scopes.addProject).toHaveBeenCalledOnce();
  };
}

it.each([
  { source: "New project", input: "new-project" },
  { source: "Local folder", input: "/workspace/existing" },
])("keeps a reopened palette open when $source finishes late", async ({ source, input }) => {
  setup();
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  const finish = await startLateProjectAdd(source, input);
  const search = page.getByRole("combobox");
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
  await act(() => openCommandPalette());
  await search.fill("another search");

  await finish();
  expect(page.getByTestId("command-palette").element()).toHaveAttribute("data-open");
  expect(search.element()).toHaveValue("another search");
});

it("keeps the view the user went back to when a folder add finishes late", async () => {
  setup();
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  const finish = await startLateProjectAdd("Local folder", "/workspace/existing");
  await page.getByRole("combobox").fill("");
  await expect.element(page.getByText("Git URL", { exact: true })).toBeVisible();

  await finish();
  expect(page.getByTestId("command-palette").element()).toHaveAttribute("data-open");
  expect(page.getByText("Git URL", { exact: true }).element()).toBeVisible();
});

it.each(["/", "/?panel=files"])(
  "opens the added folder after navigation to the same page (%s)",
  async (to) => {
    setup();
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);
    const finish = await startLateProjectAdd("Local folder", "/workspace/next");

    await act(() => screen.router!.navigate({ to }));
    await finish();

    expect(scopes.openDraft).toHaveBeenCalledOnce();
  },
);

const environmentId = EnvironmentId.make("local");
const project = (name: string): EnvironmentProject => ({
  id: ProjectId.make(name),
  environmentId,
  title: name,
  workspaceRoot: `/workspace/${name}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  scripts: [],
});

it.each([
  { selection: [], expected: "added" },
  { selection: ["other"], expected: "other" },
  { selection: ["other", "original"], expected: "original" },
])("keeps the draft's project selection after switching threads (%j)", async (row) => {
  setup();
  const draftId = DraftId.make("draft-adding-project");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(
    scopeProjectRef(environmentId, ProjectId.make("original")),
    draftId,
  );
  store.setPrompt(draftId, "Keep this draft");
  scopes.waitForProject.mockResolvedValue(project("added"));
  try {
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);
    const finish = await startLateProjectAdd("Local folder", "/workspace/added", draftId);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    await act(() => {
      for (const name of row.selection) moveDraftToProject(draftId, project(name));
    });
    await act(() =>
      screen.router!.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: "another-thread" },
      }),
    );
    await finish();

    expect(screen.router!.state.location.pathname).toBe("/local/another-thread");
    expect(scopes.openDraft).not.toHaveBeenCalled();
    expect(store.getDraftSession(draftId)?.projectId).toBe(row.expected);
  } finally {
    store.clearDraftThread(draftId);
  }
});

it.each([
  { replyOrder: ["older", "newer"], assignments: ["original", "newer"] },
  { replyOrder: ["newer", "older"], assignments: ["newer", "newer"] },
] as const)("uses the newer folder selection when replies arrive %j", async (row) => {
  setup();
  const draftId = DraftId.make("draft-adding-two-projects");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(
    scopeProjectRef(environmentId, ProjectId.make("original")),
    draftId,
  );
  store.setPrompt(draftId, "Keep this draft");
  const pending = {
    older: Promise.withResolvers<{ _tag: "Success"; value: { projectId: string } }>(),
    newer: Promise.withResolvers<{ _tag: "Success"; value: { projectId: string } }>(),
  };
  scopes.addProject
    .mockReturnValueOnce(pending.older.promise)
    .mockReturnValueOnce(pending.newer.promise);
  try {
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    for (const name of ["older", "newer"]) {
      await submitProjectAdd("Local folder", `/workspace/${name}`, draftId);
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    }
    for (const [index, name] of row.replyOrder.entries()) {
      scopes.waitForProject.mockResolvedValue(project(name));
      await act(async () => {
        pending[name].resolve({ _tag: "Success", value: { projectId: name } });
        await pending[name].promise;
      });
      expect(store.getDraftSession(draftId)?.projectId).toBe(row.assignments[index]);
    }
  } finally {
    store.clearDraftThread(draftId);
  }
});

it("keeps a reopened palette open after a late folder pick", async () => {
  setup();
  const picked = Promise.withResolvers<string>();
  const pickFolder = vi.fn(() => picked.promise);
  using _bridge = stubGlobal("desktopBridge", {
    getWslState: async () => null,
    pickFolder,
  });
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("Local folder", { exact: true }).click();
  const search = page.getByRole("combobox");
  page
    .getByRole("button", { name: /^Open in / })
    .element()
    .focus();
  await userEvent.keyboard("{Enter}");
  expect(pickFolder).toHaveBeenCalledOnce();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
  await act(() => openCommandPalette());
  await search.fill("another search");

  await act(async () => {
    picked.resolve("/workspace/picked");
    await picked.promise;
  });
  expect(scopes.addProject).toHaveBeenCalledOnce();
  expect(page.getByTestId("command-palette").element()).toHaveAttribute("data-open");
  expect(search.element()).toHaveValue("another search");
});

it("keeps the source list visible after a dismissed repository lookup succeeds", async () => {
  setup(undefined, githubAvailable);
  const repository = AsyncResult.success({
    provider: "github",
    nameWithOwner: "example/slow",
    url: "https://github.com/example/slow",
    sshUrl: "git@github.com:example/slow.git",
  });
  const lookup = Promise.withResolvers<typeof repository>();
  scopes.lookupRepository.mockReset().mockReturnValue(lookup.promise);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByRole("option", { name: /^GitHub repository/ }).click();
  await page.getByRole("combobox").fill("example/slow");
  await userEvent.keyboard("{Enter}");
  expect(scopes.lookupRepository).toHaveBeenCalledOnce();
  await page.getByRole("combobox").fill("");
  await userEvent.keyboard("{Backspace}");
  const sources = page.getByText("Git URL", { exact: true });
  await expect.element(sources).toBeVisible();

  await act(async () => {
    lookup.resolve(repository);
    await lookup.promise;
  });
  expect(sources.element()).toBeVisible();
});

it("looks up a corrected repository name after the pending reply for the old one", async () => {
  setup(undefined, githubAvailable);
  const repository = AsyncResult.success({
    provider: "github",
    nameWithOwner: "example/slow",
    url: "https://github.com/example/slow",
    sshUrl: "git@github.com:example/slow.git",
  });
  const lookup = Promise.withResolvers<typeof repository>();
  scopes.lookupRepository
    .mockReset()
    .mockReturnValueOnce(lookup.promise)
    .mockReturnValueOnce(Promise.withResolvers<typeof repository>().promise);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByRole("option", { name: /^GitHub repository/ }).click();
  const input = page.getByRole("combobox");
  await input.fill("example/slow");
  await userEvent.keyboard("{Enter}");
  expect(scopes.lookupRepository).toHaveBeenCalledOnce();
  await input.fill("example/corrected");

  await act(async () => {
    lookup.resolve(repository);
    await lookup.promise;
  });
  expect(input.element()).toHaveValue("example/corrected");
  await userEvent.keyboard("{Enter}");
  expect(scopes.lookupRepository).toHaveBeenLastCalledWith(
    expect.objectContaining({ input: { provider: "github", repository: "example/corrected" } }),
  );
});
