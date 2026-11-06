import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

const pickerMocks = vi.hoisted(() => ({
  settings: { preferNativeProjectFolderPicker: false },
  target: "primary",
  pickFolder: vi.fn<() => Promise<string | null>>(),
  command: vi.fn(),
}));

function setupPicker(enabled = false) {
  if (!Object.getOwnPropertyDescriptor(window, "desktopBridge")) {
    Object.defineProperty(window, "desktopBridge", { configurable: true, get: () => undefined });
  }
  pickerMocks.target = "primary";
  pickerMocks.settings.preferNativeProjectFolderPicker = enabled;
  pickerMocks.pickFolder.mockReset().mockResolvedValue(null);
  pickerMocks.command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
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
  useClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, ...pickerMocks.settings }),
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
vi.mock("../connection/useDesktopLocalBootstraps", () => ({
  useDesktopLocalBootstraps: () => [{ id: "native", httpBaseUrl: "http://desktop-local" }],
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => pickerMocks.command,
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: pickerMocks.target === "primary" ? "local" : "secondary",
        displayUrl: "http://desktop-local",
        label: "Local",
        connection: { phase: "connected" },
        entry: {
          target:
            pickerMocks.target === "primary"
              ? { _tag: "PrimaryConnectionTarget" }
              : {
                  _tag: "BearerConnectionTarget",
                  connectionId: pickerMocks.target === "desktop-local" ? "local:native" : "remote",
                },
        },
        serverConfig: {
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
          settings: { addProjectBaseDirectory: "/workspace/" },
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
  useEnvironmentScope: () => true,
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
    setupPicker();
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

describe("add-project native folder preference", () => {
  it.each([false, true])(
    "uses the built-in browser without a desktop bridge: %s",
    async (enabled) => {
      setupPicker(enabled);
      using _bridge = vi.spyOn(window, "desktopBridge", "get").mockReturnValue(undefined);
      await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
      await act(() => openCommandPalette({ open: "add-project" }));
      await page.getByText("Local folder", { exact: true }).click();
      await expect.element(page.getByRole("combobox")).toHaveValue("/workspace/");
      expect(pickerMocks.pickFolder).not.toHaveBeenCalled();
    },
  );

  it("adds the native selection to the selected environment", async () => {
    setupPicker(true);
    pickerMocks.pickFolder.mockResolvedValue("/workspace/native-project");
    using _bridge = vi.spyOn(window, "desktopBridge", "get").mockReturnValue({
      pickFolder: pickerMocks.pickFolder,
      getWslState: async () => null,
    } as unknown as NonNullable<typeof window.desktopBridge>);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText("Local folder", { exact: true }).click();
    await vi.waitFor(() =>
      expect(pickerMocks.command).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: "local",
          input: expect.objectContaining({ workspaceRoot: "/workspace/native-project" }),
        }),
      ),
    );
    expect(pickerMocks.pickFolder).toHaveBeenCalledExactlyOnceWith({ initialPath: "/workspace" });
    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
  });
  it.each(["cancel", "error"] as const)("allows another attempt after %s", async (result) => {
    setupPicker(true);
    if (result === "error")
      pickerMocks.pickFolder.mockRejectedValueOnce(new Error("Picker unavailable"));
    using _bridge = vi.spyOn(window, "desktopBridge", "get").mockReturnValue({
      pickFolder: pickerMocks.pickFolder,
      getWslState: async () => null,
    } as unknown as NonNullable<typeof window.desktopBridge>);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText("Local folder", { exact: true }).click();
    await vi.waitFor(() => expect(pickerMocks.pickFolder).toHaveBeenCalledOnce());
    await expect.element(page.getByText("Local folder", { exact: true })).toBeVisible();
    expect(pickerMocks.command).not.toHaveBeenCalled();
    await page.getByText("Local folder", { exact: true }).click();
    await vi.waitFor(() => expect(pickerMocks.pickFolder).toHaveBeenCalledTimes(2));
  });

  it("keeps one picker in flight and restores the built-in browser when disabled", async () => {
    setupPicker(true);
    let finishPicker!: (path: string | null) => void;
    pickerMocks.pickFolder.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPicker = resolve;
      }),
    );
    using _bridge = vi.spyOn(window, "desktopBridge", "get").mockReturnValue({
      pickFolder: pickerMocks.pickFolder,
      getWslState: async () => null,
    } as unknown as NonNullable<typeof window.desktopBridge>);
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText("Local folder", { exact: true }).click();
    await vi.waitFor(() => expect(pickerMocks.pickFolder).toHaveBeenCalledOnce());
    await page.getByText("Local folder", { exact: true }).click();
    expect(pickerMocks.pickFolder).toHaveBeenCalledOnce();
    await act(() => finishPicker(null));
    await userEvent.keyboard("{Escape}");
    pickerMocks.settings.preferNativeProjectFolderPicker = false;
    await screen.rerender(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText("Local folder", { exact: true }).click();
    await expect.element(page.getByRole("combobox")).toHaveValue("/workspace/");
    expect(pickerMocks.pickFolder).toHaveBeenCalledOnce();
  });

  it.each(["remote", "desktop-local"])("uses the correct picker for %s", async (target) => {
    setupPicker(true);
    pickerMocks.target = target;
    using _bridge = vi.spyOn(window, "desktopBridge", "get").mockReturnValue({
      pickFolder: pickerMocks.pickFolder,
      getWslState: async () => null,
    } as unknown as NonNullable<typeof window.desktopBridge>);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText("Local folder", { exact: true }).click();
    if (target === "remote") {
      await expect.element(page.getByRole("combobox")).toHaveValue("/workspace/");
      expect(pickerMocks.pickFolder).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() =>
        expect(pickerMocks.pickFolder).toHaveBeenCalledExactlyOnceWith({
          initialPath: "/workspace",
          targetEnvironmentId: "native",
        }),
      );
    }
  });
});

it("keeps the caret in place when an edit briefly makes the folder path not a path", async () => {
  setupPicker();
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
