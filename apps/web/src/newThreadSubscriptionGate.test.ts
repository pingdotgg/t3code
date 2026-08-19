import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Project } from "./types";

const mocks = vi.hoisted(() => ({
  detailAtom: vi.fn((ref) => ({ kind: "detail", ref })),
  navigate: vi.fn(async () => undefined),
  projects: [] as unknown[],
  shellAtom: vi.fn((ref) => ({ kind: "shell", ref })),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly kind?: string }) => {
    if (atom.kind === "settings") {
      return {
        defaultThreadEnvMode: "local",
        newWorktreesStartFromOrigin: false,
      };
    }
    return null;
  },
}));

vi.mock("@t3tools/client-runtime/state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/threads")>()),
  mergeEnvironmentThread: () => null,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({
    state: { matches: [{ params: {} }] },
    navigate: mocks.navigate,
  }),
}));

vi.mock("./hooks/useSettings", () => ({
  useClientSettings: (
    selector: (settings: {
      sidebarProjectGroupingMode: "repository";
      sidebarProjectGroupingOverrides: Record<string, never>;
    }) => unknown,
  ) =>
    selector({
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    }),
}));

vi.mock("./state/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/server")>()),
  primaryServerSettingsAtom: { kind: "settings" },
}));

vi.mock("./state/threads", () => ({
  environmentThreadDetails: {
    detailAtom: mocks.detailAtom,
  },
  environmentThreadShells: {
    threadShellAtom: mocks.shellAtom,
  },
}));

vi.mock("./state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/entities")>()),
  readThreadShell: () => null,
  useProjects: () => mocks.projects,
}));

import { useComposerDraftStore } from "./composerDraftStore";
import { buildProjectActionItems } from "./components/CommandPalette.logic";
import { useNewThreadHandler } from "./hooks/useHandleNewThread";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "./sidebarProjectGrouping";
import { useThread } from "./state/entities";

const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make("environment-primary");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const REMOTE_PROJECT_ID = ProjectId.make("project-remote");
const REPOSITORY_IDENTITY = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-primary"),
    environmentId: PRIMARY_ENVIRONMENT_ID,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: REPOSITORY_IDENTITY,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    defaultThreadEnvMode: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function resetComposerDraftStore(): void {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("new-thread project selection subscription gating", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    mocks.detailAtom.mockClear();
    mocks.navigate.mockClear();
    mocks.projects = [];
    mocks.shellAtom.mockClear();
  });

  it("keeps the selected project's reserved thread out of detail subscriptions until its shell exists", async () => {
    const primaryProject = makeProject();
    const remoteProject = makeProject({
      id: REMOTE_PROJECT_ID,
      environmentId: REMOTE_ENVIRONMENT_ID,
      workspaceRoot: "/srv/shared-repo",
    });
    mocks.projects = [primaryProject, remoteProject];

    const handlerRef: { current: ReturnType<typeof useNewThreadHandler> | null } = {
      current: null,
    };
    function NewThreadHandlerProbe() {
      handlerRef.current = useNewThreadHandler();
      return null;
    }
    renderToStaticMarkup(createElement(NewThreadHandlerProbe));
    const runNewThread = handlerRef.current;
    if (runNewThread === null) {
      throw new Error("Expected the new-thread handler to render");
    }

    const groups = buildSidebarProjectSnapshots({
      projects: [primaryProject, remoteProject],
      settings: {
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {},
      },
      primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      resolveEnvironmentLabel: () => null,
    });
    const [pickerEntry] = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: scopeProjectRef(REMOTE_ENVIRONMENT_ID, REMOTE_PROJECT_ID),
    });
    if (!pickerEntry) {
      throw new Error("Expected a project-picker entry");
    }

    const pickerProject = {
      ...pickerEntry.targetProject,
      title: pickerEntry.group.displayName,
    };
    const [projectAction] = buildProjectActionItems({
      projects: [pickerProject],
      valuePrefix: "new-thread-in",
      icon: () => null,
      runProject: async (project) => {
        await runNewThread(scopeProjectRef(project.environmentId, project.id));
      },
    });
    if (!projectAction) {
      throw new Error("Expected a Command Palette project action");
    }

    await projectAction.run();
    const openedDraft = useComposerDraftStore
      .getState()
      .getDraftSessionByProjectRef(scopeProjectRef(REMOTE_ENVIRONMENT_ID, REMOTE_PROJECT_ID));
    if (openedDraft === null) {
      throw new Error("Expected the selected project to open a draft");
    }

    const threadRef = scopeThreadRef(REMOTE_ENVIRONMENT_ID, openedDraft.threadId);
    expect(pickerEntry.targetProject).toMatchObject({
      environmentId: REMOTE_ENVIRONMENT_ID,
      id: REMOTE_PROJECT_ID,
    });
    expect(useComposerDraftStore.getState().getDraftThreadByRef(threadRef)).toMatchObject({
      environmentId: REMOTE_ENVIRONMENT_ID,
      projectId: REMOTE_PROJECT_ID,
    });

    function ThreadProbe() {
      useThread(threadRef);
      return null;
    }
    renderToStaticMarkup(createElement(ThreadProbe));

    expect(mocks.shellAtom).toHaveBeenCalledWith(threadRef);
    expect(mocks.detailAtom).not.toHaveBeenCalled();
  });
});
