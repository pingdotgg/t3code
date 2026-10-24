import { act, render, type Screen } from "../../test/render";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => providers) as never,
    },
  };
});
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => state.settings) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  ProjectScriptEditorDialog,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";

const onSubmit = vi.fn<Parameters<typeof ProjectScriptEditorDialog>[0]["onSubmit"]>();
const onClose = vi.fn();
const onDelete = vi.fn();

function request(name: string, error?: string): ProjectScriptEditorRequest {
  return {
    scriptId: name,
    initial: { ...EMPTY_PROJECT_SCRIPT_INPUT, name, command: `run-${name}` },
    ...(error === undefined ? {} : { error }),
  };
}

const open = (
  screen: Screen,
  nextRequest: ProjectScriptEditorRequest,
  projectId: ProjectId | null = null,
) =>
  screen.rerender(
    <RegistryContext.Provider value={appAtomRegistry}>
      <StrictMode>
        <ProjectScriptEditorDialog
          environmentId={EnvironmentId.make("test")}
          projectId={projectId}
          request={nextRequest}
          scripts={[]}
          onSubmit={onSubmit}
          onClose={onClose}
          onDelete={onDelete}
        />
      </StrictMode>
    </RegistryContext.Provider>,
  );

const submit = () => document.querySelector("form")!.requestSubmit();
const saveButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;

function deferredSave() {
  let resolve!: (result: ProjectScriptActionResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ProjectScriptActionResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  return { promise, resolve, reject };
}

async function setup() {
  onSubmit.mockReset();
  onClose.mockReset();
  onDelete.mockReset();
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  await act(async () => appAtomRegistry.set(state.providers, []));
}

describe("project action editor save lifecycle", () => {
  it("does not close a replacement request or release its in-flight save", async () => {
    await setup();
    await using screen = await render(null);
    const first = deferredSave();
    const second = deferredSave();
    onSubmit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await open(screen, request("build"));
    await act(async () => submit());

    await open(screen, request("test"));
    expect(saveButton().disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#script-name")!.value).toBe("test");
    await act(async () => submit());

    await act(async () => first.resolve(AsyncResult.success(undefined)));
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);

    await act(async () => second.resolve(AsyncResult.success(undefined)));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls.map(([scriptId]) => scriptId)).toEqual(["build", "test"]);
  });
});

it("switches from shell to prompt, records a shortcut, and saves the prompt editor", async () => {
  await setup();
  onSubmit.mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(null);
  await open(screen, {
    scriptId: null,
    initial: { ...EMPTY_PROJECT_SCRIPT_INPUT, name: "Research status" },
  });
  await expect.element(page.getByLabelText("Command", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("combobox", { name: "Action type" }));
  await userEvent.click(page.getByRole("option", { name: "Prompt", exact: true }));
  await expect.element(page.getByLabelText("Command", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(page.getByText("Run automatically on worktree creation"))
    .not.toBeInTheDocument();
  await userEvent.type(
    page.getByLabelText("Prompt", { exact: true }),
    "Read instructions. Report results without edits.",
  );
  await userEvent.click(page.getByLabelText("Keybinding", { exact: true }));
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  await expect
    .element(page.getByLabelText("Keybinding", { exact: true }))
    .toHaveValue("ctrl+shift+p");
  await act(async () => submit());
  await vi.waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        type: "prompt",
        prompt: "Read instructions. Report results without edits.",
        name: "Research status",
        keybinding: "ctrl+shift+p",
      }),
    ),
  );
});

it("shows a provider that only the project enables", async () => {
  await setup();
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex Work",
    enabled: false,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-23T00:00:00.000Z",
    models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
    skills: [],
    slashCommands: [],
  };
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
    },
    projectSettingsOverrides: {
      [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
    },
  };
  await act(async () => appAtomRegistry.set(state.providers, [provider]));
  await using screen = await render(null);
  await open(
    screen,
    {
      scriptId: "status",
      initial: {
        ...EMPTY_PROJECT_SCRIPT_INPUT,
        type: "prompt",
        prompt: "Report status.",
        modelSelection: { instanceId, model: "gpt-5" },
      },
    },
    projectId,
  );

  await userEvent.click(page.getByRole("button", { name: /GPT-5/ }));
  await expect.element(page.getByRole("button", { name: "Codex Work", exact: true })).toBeVisible();
});

it("falls back to a project-enabled model when the environment default is disabled", async () => {
  await setup();
  onSubmit.mockResolvedValue(AsyncResult.success(undefined));
  const projectId = ProjectId.make("project-a");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
  const providers: ReadonlyArray<ServerProvider> = [
    {
      instanceId: codexInstanceId,
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-23T00:00:00.000Z",
      models: [
        { slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true, capabilities: null },
      ],
      skills: [],
      slashCommands: [],
    },
    {
      instanceId: claudeInstanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-23T00:00:00.000Z",
      models: [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      skills: [],
      slashCommands: [],
    },
  ];
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    projectSettingsOverrides: {
      [projectId]: { providerInstances: { [codexInstanceId]: { enabled: false } } },
    },
  };
  await act(async () => appAtomRegistry.set(state.providers, providers));
  await using screen = await render(null);
  await open(
    screen,
    {
      scriptId: "review",
      initial: {
        ...EMPTY_PROJECT_SCRIPT_INPUT,
        name: "Review",
        type: "prompt",
        prompt: "Review the code.",
      },
    },
    projectId,
  );

  await userEvent.click(page.getByText("Use the thread's current model"));
  await expect.element(page.getByRole("button", { name: /Claude Opus 4.8/ })).toBeVisible();

  await act(async () => submit());
  await vi.waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      "review",
      expect.objectContaining({
        modelSelection: { instanceId: claudeInstanceId, model: "claude-opus-4-8" },
      }),
    ),
  );
});

it("applies and displays an Ultrathink choice in the prompt", async () => {
  await setup();
  onSubmit.mockResolvedValue(AsyncResult.success(undefined));
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const model = "claude-sonnet-4-5";
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-23T00:00:00.000Z",
    models: [
      {
        slug: model,
        name: "Claude Sonnet 4.5",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              currentValue: "high",
              promptInjectedValues: ["ultrathink"],
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High", isDefault: true },
                { id: "ultrathink", label: "Ultrathink" },
              ],
            },
          ],
        },
      },
    ],
    skills: [],
    slashCommands: [],
  };
  await act(async () => appAtomRegistry.set(state.providers, [provider]));
  await using screen = await render(null);
  await open(screen, {
    scriptId: "review",
    initial: {
      ...EMPTY_PROJECT_SCRIPT_INPUT,
      name: "Review",
      type: "prompt",
      prompt: "Review the code.",
      modelSelection: { instanceId, model, options: [{ id: "effort", value: "high" }] },
    },
  });

  await userEvent.click(page.getByRole("button", { name: "High", exact: true }));
  await userEvent.click(page.getByRole("menuitemradio", { name: /Ultrathink/ }));
  await expect
    .element(page.getByLabelText("Prompt", { exact: true }))
    .toHaveValue("Ultrathink:\nReview the code.");
  await expect.element(page.getByRole("button", { name: "Ultrathink", exact: true })).toBeVisible();

  await act(async () => submit());
  await vi.waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      "review",
      expect.objectContaining({ prompt: "Ultrathink:\nReview the code." }),
    ),
  );
});
