import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, createContext, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { IncomingShareDraft } from "../sharing/incoming-share-model";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import { makeIncomingShareImports, type ShareImportDeps } from "./incomingShareImport";
import { newTaskFlowKey } from "./new-task-flow-state";
import type { useNewTaskFlow } from "./new-task-flow-provider";
import { NewTaskDraftScreen } from "./NewTaskDraftScreen";
import type { ThreadScreenBinding } from "./ThreadScreenHost";

const harness = vi.hoisted(() => ({
  projects: vi.fn(),
  flow: vi.fn(),
  focused: vi.fn(),
  getShare: vi.fn(),
  imports: vi.fn<() => ReturnType<typeof makeIncomingShareImports>>(),
  readDraft: vi.fn(),
  back: vi.fn(),
  preventRemove: vi.fn(),
  navigation: { dispatch: vi.fn(), navigate: vi.fn() },
  route: { key: "draft-route", params: { draft: { requestId: "shared-draft" } } },
}));

vi.mock("@react-navigation/native", () => ({
  CommonActions: { navigate: (name: string) => ({ type: "NAVIGATE", payload: { name } }) },
  useIsFocused: harness.focused,
  useNavigation: () => harness.navigation,
  usePreventRemove: harness.preventRemove,
  useRoute: () => harness.route,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: TestButton,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: vi.fn() },
}));
vi.mock("../../components/ComposerEditor", () => ({
  ComposerEditor: ({ readOnly }: { readOnly?: boolean }) => <textarea readOnly={readOnly} />,
}));
vi.mock("../../components/ComposerToolbar", () => ({ ComposerInlineControl: TestButton }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({
  NativeScrollEdgeEffectsContext: createContext({}),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => ({ _tag: "Initial" }) },
}));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: Atom.make(null) }));
vi.mock("../../state/composer-attachment-uploads", () => ({
  composerAttachmentUploadsAtom: Atom.make({}),
  composerAttachmentUploadBlockReason: () => null,
  composerAttachmentsStillUploading: () => false,
}));
vi.mock("../../state/entities", () => ({
  useProjects: harness.projects,
  useEnvironmentServerConfig: () => null,
}));
vi.mock("../../state/projectClones", () => ({ useProjectClone: () => null }));
vi.mock("../../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("../../state/thread-outbox", () => ({}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => undefined }));
vi.mock("../../state/use-composer-attachment-actions", () => ({
  useComposerAttachmentActions: () => ({}),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  composerContextImportsAtom: Atom.make({}),
  getComposerDraftSnapshot: harness.readDraft,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnections: () => ({}),
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
}));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({ useHardwareKeyboardCommand: () => {} }));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => harness.back,
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({ getShare: harness.getShare, isLoading: false }),
  get incomingShareImports() {
    return harness.imports();
  },
}));
vi.mock("../connection/ConnectionStatusDot", () => ({ ConnectionStatusDot: () => null }));
vi.mock("./new-task-flow-provider", () => ({ useNewTaskFlow: harness.flow }));
vi.mock("./DraftEnvironmentControl", () => ({ DraftEnvironmentControl: () => null }));
vi.mock("./DraftThreadHeader", () => ({ DraftThreadHeader: () => null }));
vi.mock("./ProjectCloneBanner", () => ({ ProjectCloneBanner: () => null }));
vi.mock("./ThreadScreenHost", () => ({
  ThreadScreenFallback: ({ children }: { children?: ReactNode }) => children,
  // Render the draft slots at a short viewport height, as when the keyboard is up.
  ThreadScreenBinding: ({ draftMode }: ComponentProps<typeof ThreadScreenBinding>) => (
    <>
      {draftMode?.controls?.(300)}
      <textarea aria-label="Draft" readOnly={draftMode?.interactionLocked} />
    </>
  ),
}));
vi.mock("./useRememberThreadProject", () => ({ useRememberThreadProject: () => {} }));

function TestButton(props: {
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
}) {
  return (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  );
}

function project(id: string): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make("env"),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: "local",
    scripts: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const sharePickerCases = ["with a fallback project", "with an empty catalog"];

it.each(sharePickerCases)("reopens the dismissed share picker %s", async (scenario) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const share: IncomingShareDraft = {
    schemaVersion: 1,
    id: "share-1",
    createdAt: "2026-01-01T00:00:00Z",
    text: "shared text",
    attachments: [],
    warnings: [],
  };
  const fallback = project("fallback");
  const destination = project("destination");
  const projects = [fallback, destination];
  const draftKey = "new-task:destination";
  const consume = Promise.withResolvers<void>();
  let inbox: IncomingShareDraft | null = share;
  let draft: ComposerDraft = { text: "", attachments: [] };
  const reserve = vi.fn<ShareImportDeps["reserve"]>().mockResolvedValue(undefined);
  const imports = makeIncomingShareImports({
    registry,
    getShare: () => inbox,
    reserve,
    release: async () => {},
    consume: async () => {
      await consume.promise;
      inbox = null;
    },
    readDraft: () => draft,
    mergeIntoDraft: async (_key, content) => {
      draft = { text: content.text, attachments: [] };
      return { skippedAttachmentCount: 0 };
    },
    selectAttachments: () => ({ status: "ready", attachments: [], warnings: [] }),
    undoMerge: async () => {},
    releaseUnusedAttachments: () => {},
    onWarnings: () => {},
    onImportFailure: (_target, error) => {
      throw error;
    },
    onCancelFailure: () => {},
    leave: () => {},
  });

  harness.projects.mockReturnValue(projects);
  harness.getShare.mockImplementation(() => inbox);
  harness.imports.mockReturnValue(imports);
  harness.readDraft.mockImplementation(() => draft);
  const flow = {
    attachments: [],
    availableBranches: [],
    canChooseWorkspace: true,
    currentCheckoutBranchName: "main",
    draftKey: null as string | null,
    environments: [],
    isGitRepo: true,
    loadBranches: () => {},
    projectScopes: projects.map((candidate) => ({
      key: candidate.id,
      title: candidate.title,
      representative: candidate,
      projects: [candidate],
      pinned: false,
      archived: false,
      projectRefs: [{ environmentId: candidate.environmentId, projectId: candidate.id }],
    })),
    runtimeMode: "full-access",
    selectedBranchName: "main",
    selectedModel: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    selectedProject: fallback,
    selectedProjectKey: null as string | null,
    selectedWorktreePath: null,
    submitting: false,
    workspaceMode: "local",
  } satisfies Partial<ReturnType<typeof useNewTaskFlow>>;
  harness.flow.mockImplementation(() => ({ ...flow }));

  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const render = (focused: boolean) => {
    harness.focused.mockReturnValue(focused);
    return (
      <RegistryContext.Provider value={registry}>
        <NewTaskDraftScreen incomingShareId={share.id} />
      </RegistryContext.Provider>
    );
  };
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const editor = () => container.querySelector("textarea")!;

  const hasFallback = scenario === "with a fallback project";
  harness.projects.mockReturnValue(hasFallback ? projects : []);
  harness.flow.mockImplementation(() => ({
    ...flow,
    projectScopes: hasFallback ? flow.projectScopes : [],
    selectedModel: null,
    selectedProject: hasFallback ? fallback : null,
  }));
  act(() => root.render(render(true)));
  expect(harness.navigation.dispatch).toHaveBeenCalledWith({
    type: "NAVIGATE",
    payload: { name: "NewTaskProject" },
  });
  act(() => root.render(render(false)));
  act(() => root.render(render(true)));

  if (hasFallback) expect(editor().readOnly).toBe(true);
  const initialProjectLabel = hasFallback ? "Project: fallback" : "Choose project";
  expect(button(initialProjectLabel)?.disabled).toBe(false);
  act(() => button(initialProjectLabel).click());
  expect(harness.navigation.navigate).toHaveBeenCalledExactlyOnceWith("NewTaskProject", {
    incomingShareId: share.id,
  });
  harness.navigation.navigate.mockClear();
  harness.projects.mockReturnValue(projects);
  harness.flow.mockImplementation(() => ({ ...flow }));
  act(() => root.render(render(true)));

  expect(harness.navigation.dispatch).toHaveBeenCalledTimes(1);
  expect(harness.back).not.toHaveBeenCalled();
  expect(harness.preventRemove).toHaveBeenLastCalledWith(false, expect.any(Function));
  expect(editor().readOnly).toBe(true);
  expect(button("Project: fallback").disabled).toBe(false);
  act(() => button("Project: fallback").click());
  expect(harness.navigation.navigate).toHaveBeenCalledWith("NewTaskProject", {
    incomingShareId: share.id,
  });
  expect(button("Current checkout").disabled).toBe(true);
  expect(button("Branch: main").disabled).toBe(true);

  // The picker returns with the selected project and its draft.
  act(() => root.render(render(false)));
  flow.selectedProject = destination;
  flow.selectedProjectKey = `${destination.environmentId}:${destination.id}`;
  flow.draftKey = draftKey;
  act(() => root.render(render(true)));
  expect(editor().readOnly).toBe(true);
  expect(button("Project: destination").disabled).toBe(true);

  await act(async () => {
    consume.resolve();
    await imports.settled({
      flowKey: newTaskFlowKey(harness.route)!,
      routeKey: harness.route.key,
      draftKey,
      destination: { environmentId: destination.environmentId, projectId: destination.id },
      shareId: share.id,
    });
  });

  expect(reserve).toHaveBeenCalledExactlyOnceWith(share.id, {
    environmentId: destination.environmentId,
    projectId: destination.id,
  });
  expect(draft.text).toBe(share.text);
  expect(editor().readOnly).toBe(false);
  expect(button("Current checkout").disabled).toBe(false);
  expect(button("Branch: main").disabled).toBe(false);
});
