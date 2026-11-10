import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as Option from "effect/Option";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import { act, render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

const commands = vi.hoisted(() => ({
  run: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  createNew: vi.fn(async (_input: unknown) => true),
  query: vi.fn<(_input: unknown) => Promise<{ _tag: "Success"; value: unknown }>>(async () => ({
    _tag: "Success",
    value: undefined,
  })),
}));
const state = vi.hoisted(() => ({
  discoveryKey: Symbol("source-control discovery"),
  discovery: undefined as SourceControlDiscoveryResult | undefined,
  canOperate: true,
  multipleEnvironments: false,
  deniedScope: undefined as string | undefined,
}));

function setup(deniedScope?: string) {
  commands.run.mockClear();
  commands.createNew.mockClear();
  commands.query.mockReset();
  commands.query.mockResolvedValue({ _tag: "Success", value: undefined });
  state.discovery = undefined;
  state.canOperate = true;
  state.multipleEnvironments = false;
  state.deniedScope = deniedScope;
}

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
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => commands.createNew }));
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
  useAtomCommand: () => commands.run,
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => commands.query,
}));
vi.mock("../state/sourceControl", async (original) => {
  const actual = await original<typeof import("../state/sourceControl")>();
  return {
    ...actual,
    sourceControlEnvironment: {
      ...actual.sourceControlEnvironment,
      discovery: () => state.discoveryKey,
    },
  };
});
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: (state.multipleEnvironments ? ["local", "remote"] : ["local"]).map(
      (environmentId) => ({
        environmentId,
        label: environmentId === "local" ? "Local" : "Remote",
        connection: { phase: "connected" },
        entry: {
          target:
            environmentId === "local"
              ? { _tag: "PrimaryConnectionTarget" }
              : { _tag: "BearerConnectionTarget", connectionId: "test-remote" },
        },
        serverConfig: {
          newProjectsRoot: "/workspace/",
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
          settings: { addProjectBaseDirectory: "/workspace/" },
        },
      }),
    ),
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
  useEnvironmentScope: (_environmentId: unknown, scope: string) =>
    state.canOperate && scope !== state.deniedScope,
  readEnvironmentScope: () => state.canOperate,
}));
vi.mock("../state/filesystem", async (original) => ({
  ...(await original<typeof import("../state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: (query: unknown) => ({
    data: query === state.discoveryKey ? state.discovery : undefined,
    isLoading: false,
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
  { step: "folder", source: "Local folder", keys: "", description: /^(?!.*(Ctrl|⌘)).*Add.*Enter/ },
  {
    step: "highlighted folder",
    source: "Local folder",
    keys: "{ArrowDown}",
    description: /Add.*(Ctrl|⌘) Enter/,
  },
  { step: "repository", source: "Git URL", keys: "", description: /Continue.*Enter/ },
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

it.each(["", "Design system"])(
  "confirms a selected folder with the project name %j",
  async (name) => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByRole("textbox", { name: "Project name" }).fill(name);
    await page.getByRole("button", { name: "Local folder", exact: true }).click();
    await page.getByRole("combobox").fill("/workspace/project");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("textbox", { name: "Project name" }))
      .toHaveValue(name || "project");
    expect(commands.run).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(commands.run).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            title: name || "project",
            workspaceRoot: "/workspace/project",
          }),
        }),
      ),
    );
  },
);

it.each([
  { name: "", expected: "second" },
  { name: "My project", expected: "My project" },
  { name: "first", expected: "first" },
])("updates inferred names when changing folders: $name", async ({ name, expected }) => {
  setup();
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByRole("textbox", { name: "Project name" }).fill(name);
  await page.getByRole("button", { name: "Local folder", exact: true }).click();
  await page.getByRole("combobox").fill("/workspace/first");
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Tab}{Enter}");
  await page.getByRole("button", { name: "Local folder", exact: true }).click();
  await page.getByRole("combobox").fill("/workspace/second");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("textbox", { name: "Project name" })).toHaveValue(expected);
});

it.each([true, false])("creates a named project only with permission: %j", async (canOperate) => {
  setup();
  state.canOperate = canOperate;
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByRole("textbox", { name: "Project name" }).fill("  Design system  ");
  await userEvent.keyboard("{Enter}");
  if (canOperate) {
    await vi.waitFor(() =>
      expect(commands.createNew).toHaveBeenCalledWith({
        environmentId: "local",
        name: "Design system",
        publishTo: null,
      }),
    );
  } else {
    expect(commands.createNew).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Create project", exact: true }))
      .toBeDisabled();
  }
});

it.each(sourceControlClients.definitions)(
  "clones from $label with the entered project name",
  async (definition) => {
    setup();
    state.discovery = {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: definition.kind,
          label: definition.label,
          status: "available",
          version: Option.none(),
          installHint: "Install the provider",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.none(),
          },
        },
      ],
    };
    const remoteUrl = "https://scm.example.test/team/repository";
    commands.query.mockImplementation(async (input) => {
      const isLookup =
        typeof input === "object" &&
        input !== null &&
        "input" in input &&
        typeof input.input === "object" &&
        input.input !== null &&
        "repository" in input.input;
      return {
        _tag: "Success",
        value: isLookup
          ? {
              provider: definition.kind,
              nameWithOwner: "team/repository",
              url: remoteUrl,
              sshUrl: "git@scm.example.test:team/repository.git",
            }
          : undefined,
      };
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByRole("textbox", { name: "Project name" }).fill("Design system");
    await page
      .getByRole("button", { name: `${definition.pickerLabel} repository`, exact: true })
      .click();
    await page.getByRole("combobox").fill("team/repository");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("combobox")).toHaveValue("/workspace/repository");
    expect(commands.query).toHaveBeenCalledWith({
      environmentId: "local",
      input: { provider: definition.kind, repository: "team/repository" },
    });
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(commands.run).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: "local",
          input: expect.objectContaining({
            title: "Design system",
            destinationPath: "/workspace/repository",
            remoteUrl:
              definition.defaultCloneTransport === "https"
                ? remoteUrl
                : "git@scm.example.test:team/repository.git",
          }),
        }),
      ),
    );
  },
);

it.each(["", "Design system"])("clones a Git URL with project name %j", async (name) => {
  setup();
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByRole("textbox", { name: "Project name" }).fill(name);
  await page.getByRole("button", { name: "Local folder", exact: true }).click();
  await page.getByRole("combobox").fill("/workspace/first");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("textbox", { name: "Project name" }))
    .toHaveValue(name || "first");
  await userEvent.keyboard("{Tab}{Enter}");
  await page.getByRole("button", { name: "Git URL", exact: true }).click();
  await page.getByRole("combobox").fill("https://scm.example.test/team/repository.git");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("combobox")).toHaveValue("/workspace/repository");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(commands.run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          title: name || "repository",
          destinationPath: "/workspace/repository",
          remoteUrl: "https://scm.example.test/team/repository.git",
        }),
      }),
    ),
  );
});

it("keeps unconfigured integrations disabled and their setup actions reachable", async () => {
  setup();
  await using screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  for (const definition of sourceControlClients.definitions) {
    await expect
      .element(
        page.getByRole("button", {
          name: `${definition.pickerLabel} repository`,
          exact: true,
        }),
      )
      .toBeDisabled();
  }
  await page.getByRole("button", { name: "Setup Required", exact: true }).first().click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/source-control"),
  );
  expect(commands.run).not.toHaveBeenCalled();
});

it.each([
  { entry: "add-project", name: "" },
  { entry: "add-project", name: "Keep me" },
  { entry: "new-project", name: "" },
  { entry: "new-project", name: "Keep me" },
])(
  "returns to machine selection without carrying a folder: $entry $name",
  async ({ entry, name }) => {
    setup();
    state.multipleEnvironments = true;
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() =>
      openCommandPalette(
        entry === "add-project" ? { open: "add-project" } : { query: "New project" },
      ),
    );
    if (entry === "new-project") {
      await page.getByRole("option", { name: /^New project/ }).click();
    }
    await page.getByRole("option", { name: /^This device/ }).click();
    await page.getByRole("textbox", { name: "Project name" }).fill(name);
    await page.getByRole("button", { name: "Local folder", exact: true }).click();
    await page.getByRole("combobox").fill("/workspace/project");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Shift>}{Tab}{Tab}{/Shift}");
    await expect.element(page.getByRole("button", { name: "Back", exact: true })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await page.getByRole("option", { name: /^Remote/ }).click();
    await expect.element(page.getByRole("textbox", { name: "Project name" })).toHaveValue(name);
    await page.getByRole("textbox", { name: "Project name" }).fill("Remote project");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(commands.createNew).toHaveBeenCalledWith({
        environmentId: "remote",
        name: "Remote project",
        publishTo: null,
      }),
    );
    expect(commands.run).not.toHaveBeenCalled();
  },
);

it.each([
  { flow: "Git URL", value: "https://github.com/pingdotgg/t3code.git", submit: "Continue (Enter)" },
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
