import { RegistryContext } from "@effect/atom-react";
import type {
  DeleteProjectInput,
  UpdateProjectInput,
} from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Project } from "../../types";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  providers: null as Atom.Atom<ReadonlyArray<ServerProvider>> | null,
  config: null as Atom.Atom<{ keybindings: ResolvedKeybindingsConfig }> | null,
  projects: [] as Project[],
  update:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: UpdateProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  delete:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: DeleteProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  confirm: vi.fn<() => Promise<boolean>>(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
  updateClientSettings: vi.fn(),
  releaseUploads: vi.fn(),
  clearDraft: vi.fn(),
  copy: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  }),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments }),
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => state.projects,
  useThreadShells: () => [],
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { update: "update", delete: "delete" },
}));
vi.mock("~/state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => state.providers!,
    configValueAtom: () => state.config!,
    upsertKeybinding: "upsertKeybinding",
    removeKeybinding: "removeKeybinding",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: "update" | "delete" | "upsertKeybinding" | "removeKeybinding") =>
    state[command],
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateClientSettings: () => state.updateClientSettings,
  usePrimarySettings: () => DEFAULT_SERVER_SETTINGS,
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
}));
vi.mock("~/hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileState: () => ({
    status: "valid",
    file: null,
    scripts: [{ name: "Imported", command: "vp test" }],
  }),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: state.copy }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByProjectRef: () => null,
      clearProjectDraftThreadId: state.clearDraft,
    }),
  },
}));
vi.mock("~/lib/composerDraftUploads", () => ({ releaseProjectDraftUploads: state.releaseUploads }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "button",
  SelectValue: "span",
}));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuGroup: "div",
  MenuGroupLabel: "div",
  MenuItem: "button",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "span",
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsPageContainer: "div",
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({ control, resetAction }: { control?: ReactNode; resetAction?: ReactNode }) => (
    <div>
      {resetAction}
      {control}
    </div>
  ),
  SettingResetButton: ({
    label,
    ...props
  }: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }) => <button {...props} aria-label={`Reset ${label} to default`} />,
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: "model-picker" }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: "traits-picker" }));
vi.mock("./ProjectFaviconPickerDialog", () => ({
  canPickExternalProjectFavicon: () => false,
  ProjectFaviconPickerDialog: "favicon-picker",
}));
vi.mock("./ProjectIconPickerDialog", () => ({ ProjectIconPickerDialog: "icon-picker" }));
vi.mock("../projectScriptEditor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../projectScriptEditor")>()),
  ProjectScriptEditorDialog: "script-editor",
}));

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { EMPTY_PROJECT_SCRIPT_INPUT, ProjectScriptEditorDialog } from "../projectScriptEditor";
import { ProjectFaviconPickerDialog } from "./ProjectFaviconPickerDialog";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex");
const environments = [primaryId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
}));
const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});
const writable = () => AsyncResult.success(session([AuthOrchestrationOperateScope]));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.registry = AtomRegistry.make();
  state.sessions.clear();
  for (const id of [primaryId, remoteId])
    state.sessions.set(id, Atom.make<SessionResult>(writable()).pipe(Atom.keepAlive));
  state.projects = [primaryId, remoteId].map((environmentId) => ({
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}`,
    repositoryIdentity: {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
    defaultModelSelection: { instanceId, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  state.config = Atom.make({ keybindings: DEFAULT_RESOLVED_KEYBINDINGS });
  state.update.mockImplementation(async ({ environmentId, input }) => {
    const { projectId, ...patch } = input;
    state.projects = state.projects.map((project) =>
      project.environmentId === environmentId && project.id === projectId
        ? {
            ...project,
            ...patch,
            title: patch.title ?? project.title,
            workspaceRoot: patch.workspaceRoot ?? project.workspaceRoot,
          }
        : project,
    );
    return AsyncResult.success(undefined);
  });
  state.delete.mockResolvedValue(AsyncResult.success(undefined));
  state.confirm.mockResolvedValue(true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  vi.unstubAllGlobals();
});

function group() {
  return buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!;
}

async function mountPanel() {
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <ProjectSettingsPanel projectKey={group().projectKey} />
      </RegistryContext.Provider>,
    );
  });
  return renderer!.root;
}

function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
}

async function grant(id: EnvironmentId, result: SessionResult) {
  await act(() => state.registry!.set(state.sessions.get(id)!, result));
}

describe("project settings permissions", () => {
  it("preflights every member before any shared field update", async () => {
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    const root = await mountPanel();
    const name = root.findByProps({ "aria-label": "Project name" });

    await act(async () => {
      name.props.onChange();
      name.props.onBlur({ currentTarget: { value: "Renamed" } });
      root.findByType(ProjectFaviconPickerDialog).props.onSelect("/work/icon.png");
      root.findByType(ProviderModelPicker).props.onInstanceModelChange(instanceId, "gpt-5.2");
      root
        .findByType(TraitsPicker)
        .props.onModelOptionsChange([{ id: "reasoningEffort", value: "high" }]);
      root
        .findByProps({ "aria-label": "New-thread workspace" })
        .parent!.props.onValueChange("local");
      root
        .findByProps({ "aria-label": "Automatically pull the default branch" })
        .props.onCheckedChange(true);
    });

    expect(state.update).not.toHaveBeenCalled();
    expect(state.projects.every((project) => project.title === "Shared repo")).toBe(true);
    expect(name.props.disabled).toBe(true);
    expect(root.findByType(ProviderModelPicker).props.disabled).toBe(true);
    expect(root.findByType(TraitsPicker).props.disabled).toBe(true);
    expect(button("Remove all entries").props.disabled).toBe(true);
  });

  it("updates every member when all have project access without settings access", async () => {
    const root = await mountPanel();
    await act(async () =>
      root
        .findByProps({ "aria-label": "Automatically pull the default branch" })
        .props.onCheckedChange(true),
    );
    expect(state.update.mock.calls.map(([request]) => request.environmentId)).toEqual([
      primaryId,
      remoteId,
    ]);
    expect(state.projects.map((project) => project.autoPull)).toEqual([true, true]);
  });

  it("stops before the next member if its grant is revoked during an earlier update", async () => {
    const firstUpdate = deferred<AsyncResult.Success<void>>();
    state.update.mockReturnValueOnce(firstUpdate.promise);
    const root = await mountPanel();
    await act(async () =>
      root
        .findByProps({ "aria-label": "Automatically pull the default branch" })
        .props.onCheckedChange(true),
    );
    expect(state.update).toHaveBeenCalledOnce();

    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      firstUpdate.resolve(AsyncResult.success(undefined));
      await firstUpdate.promise;
    });
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]![0].environmentId).toBe(primaryId);
  });

  it("keeps the writable checkout editable and local controls usable in a mixed group", async () => {
    await grant(remoteId, AsyncResult.success(session([])));
    const root = await mountPanel();
    expect(button("Add action").props.disabled).toBe(false);
    const input = {
      name: "Build",
      command: "vp build",
      icon: EMPTY_PROJECT_SCRIPT_INPUT.icon,
      runOnWorktreeCreate: false,
      previewUrl: null,
      autoOpenPreview: false,
    };
    await act(async () => {
      button("Add action").props.onClick();
      await root.findByType(ProjectScriptEditorDialog).props.onSubmit(null, input);
    });
    expect(state.projects[0]!.scripts.map((script) => script.name)).toEqual(["Build"]);
    expect(state.projects[1]!.scripts).toEqual([]);
    expect(state.upsertKeybinding).not.toHaveBeenCalled();
    expect(state.removeKeybinding).not.toHaveBeenCalled();

    await act(() =>
      root
        .findByProps({ "aria-label": "Selected checkout" })
        .parent!.props.onValueChange(group().memberProjects[1]!.physicalProjectKey),
    );
    expect(button("Add action").props.disabled).toBe(true);
    expect(button("Remove checkout").props.disabled).toBe(true);
    await act(async () => {
      await root.findByType(ProjectScriptEditorDialog).props.onSubmit(null, input);
      root
        .findByProps({ "aria-label": "Grouping rule for remote" })
        .parent!.props.onValueChange("separate");
      root.findByProps({ "aria-label": "Copy checkout path" }).props.onClick();
    });
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.updateClientSettings).toHaveBeenCalledOnce();
    expect(state.copy).toHaveBeenCalledWith("/work/remote", { path: "/work/remote" });
  });

  it("allows removing a writable checkout while denying removal of the mixed group", async () => {
    await grant(remoteId, AsyncResult.success(session([])));
    await mountPanel();
    await act(async () => button("Remove all entries").props.onClick());
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
    await act(async () => button("Remove checkout").props.onClick());
    expect(state.delete).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: { projectId: state.projects[0]!.id, force: true },
    });
    expect(state.releaseUploads).toHaveBeenCalledOnce();
    expect(state.clearDraft).toHaveBeenCalledOnce();
  });

  it("rechecks every removal target after confirmation before deleting or clearing drafts", async () => {
    const confirmed = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmed.promise);
    await mountPanel();
    await act(async () => button("Remove all entries").props.onClick());
    expect(state.confirm).toHaveBeenCalledOnce();
    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      confirmed.resolve(true);
      await confirmed.promise;
    });
    expect(state.delete).not.toHaveBeenCalled();
    expect(state.releaseUploads).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
  });

  it("reacts to another member's revoked and restored grant and guards a stale handler", async () => {
    const root = await mountPanel();
    const autoPull = () =>
      root.findByProps({ "aria-label": "Automatically pull the default branch" });
    const staleSave = autoPull().props.onCheckedChange;
    await act(async () => {
      state.registry!.set(state.sessions.get(remoteId)!, AsyncResult.success(session([])));
      staleSave(true);
    });
    expect(state.update).not.toHaveBeenCalled();
    expect(autoPull().props.disabled).toBe(true);
    expect(button("Add action").props.disabled).toBe(false);

    await grant(remoteId, writable());
    expect(autoPull().props.disabled).toBe(false);
    await act(async () => autoPull().props.onCheckedChange(true));
    expect(state.projects.map((project) => project.autoPull)).toEqual([true, true]);
  });

  it.each([
    ["loading", () => AsyncResult.initial<AuthSessionState, Error>(), false],
    [
      "failed",
      () => AsyncResult.failure<AuthSessionState, Error>(Cause.fail(new Error("Disconnected"))),
      false,
    ],
    ["refreshing", () => AsyncResult.waiting(writable()), true],
  ] as const)(
    "uses the current grant while a member's session is %s",
    async (_state, result, allowed) => {
      await grant(remoteId, result());
      const root = await mountPanel();
      const autoPull = root.findByProps({ "aria-label": "Automatically pull the default branch" });
      expect(autoPull.props.disabled).toBe(!allowed);
      await act(async () => autoPull.props.onCheckedChange(true));
      expect(state.update).toHaveBeenCalledTimes(allowed ? 2 : 0);
    },
  );
});
