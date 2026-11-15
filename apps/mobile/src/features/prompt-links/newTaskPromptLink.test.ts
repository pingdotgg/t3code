import type { NavigationState, PartialState } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  root: undefined as NavigationState | undefined,
  dispatched: [] as unknown[],
  storageGate: Promise.resolve(),
  queries: [] as { label: string; resolve: (result: unknown) => void }[],
}));

vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    exists = true;
    parentDirectory = null;
    create() {}
    moveSync() {}
    write() {}
    async text() {
      await fixture.storageGate;
      return JSON.stringify({ schemaVersion: 1, drafts: {} });
    }
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  // The shipped stack actions, without importing the React Native view layer.
  const { StackActions }: typeof import("@react-navigation/native") =
    nativeRequire("@react-navigation/core");
  return { StackActions };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: (_registry: unknown, _atom: unknown, options: { label: string }) =>
    new Promise((resolve) => fixture.queries.push({ label: options.label, resolve })),
  runAtomCommand: () => {
    throw new Error("Unexpected command");
  },
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("./prompt-link-actions", () => ({
  showPromptLinkNotice: () => {},
  applyLinkedPromptToThreadDraft: async () => {},
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: {
    getRootState: () => fixture.root,
    dispatch: (action: unknown) => fixture.dispatched.push(action),
  },
}));
vi.mock("../../state/assets", () => ({ assetEnvironment: {} }));
vi.mock("../../state/attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("../../state/session", () => ({ environmentSession: {} }));
vi.mock("../../state/pull-requests", async () => {
  const { Atom } = await import("effect/reactivity");
  const query = (label: string) => () => Atom.make(null).pipe(Atom.withLabel(label));
  return {
    composerPullRequests: {
      linkedThreadsUncached: query("pull-request-threads"),
      detail: query("pull-request-detail"),
    },
  };
});
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("../../state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const project = {
    environmentId: "env-1",
    id: "project-1",
    title: "Linked project",
    repositoryIdentity: {
      canonicalKey: "github.com/example/linked",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/linked",
      },
    },
  };
  return { environmentProjects: { projectsAtom: Atom.make([project]) }, projectEnvironment: {} };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make([]) } };
});
vi.mock("../../state/workspace", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    workspaceStateAtom: Atom.make({
      isLoadingConnections: false,
      hasPendingShellSnapshot: false,
      connectingEnvironments: [],
    }),
    workspaceConnections: {
      environmentsAtom: Atom.make([{ environmentId: "env-1", connectionState: "connected" }]),
    },
  };
});

const { appAtomRegistry } = await import("../../state/atom-registry");
const { composerDraftsAtom, flushComposerDrafts, resetComposerDraftsLoadState } =
  await import("../../state/use-composer-drafts");
const { resolvePendingNewTaskPromptLink, takeNewTaskPromptLink } =
  await import("./newTaskPromptLink");

/** Holds draft storage closed until the returned release runs. */
function setup() {
  let release = () => {};
  fixture.storageGate = new Promise<void>((resolve) => (release = resolve));
  fixture.root = undefined;
  fixture.dispatched.length = 0;
  fixture.queries.length = 0;
  resetComposerDraftsLoadState();
  appAtomRegistry.set(composerDraftsAtom, {});
  return { releaseStorage: release };
}

function stack(...routes: NavigationState["routes"]): NavigationState {
  return {
    key: "root",
    index: routes.length - 1,
    routeNames: ["Home", "NewTaskProject", "AddProjectDestination", "Thread"],
    routes,
    stale: false,
    type: "stack",
  };
}

const home = { key: "home", name: "Home" } as const;
const newTask = (key = "new-task") => ({ key, name: "NewTaskProject" }) as const;
const addProject = { key: "add-project", name: "AddProjectDestination" } as const;

function linkedState(params: Record<string, string>): PartialState<NavigationState> {
  return { routes: [{ name: "NewTaskProject", params }] };
}

/** Takes a link as the linking config does and lands it on the focused screen. */
function openLink(params: Record<string, string>, root: NavigationState) {
  takeNewTaskPromptLink(linkedState(params));
  navigate(root);
}

function navigate(root: NavigationState) {
  fixture.root = root;
  resolvePendingNewTaskPromptLink(root);
}

async function settle() {
  await flushComposerDrafts();
  await Promise.resolve();
}

const drafts = () => Object.values(appAtomRegistry.get(composerDraftsAtom));
const repoLink = { repo: "example/linked", prompt: "Review the linked project" };
const pullRequestLink = { pr: "example/linked#7", prompt: "Review the pull request" };

function answerQuery(label: string, result: unknown) {
  const index = fixture.queries.findIndex((query) => query.label === label);
  expect(index).toBeGreaterThanOrEqual(0);
  fixture.queries.splice(index, 1)[0]!.resolve(result);
}

describe("takeNewTaskPromptLink", () => {
  it("opens the filled draft once drafts load on the screen it landed on", async () => {
    const { releaseStorage } = setup();
    openLink(repoLink, stack(home, newTask()));
    releaseStorage();
    await settle();

    expect(drafts()).toEqual([
      expect.objectContaining({
        text: "Review the linked project",
        project: expect.objectContaining({ environmentId: "env-1", projectId: "project-1" }),
      }),
    ]);
    expect(fixture.dispatched).toEqual([
      expect.objectContaining({
        type: "PUSH",
        source: "new-task",
        payload: expect.objectContaining({ name: "Thread" }),
      }),
    ]);
  });

  it.each([
    ["leaving to Home", [stack(home)]],
    [
      "pushing a screen above it and back",
      [stack(home, newTask(), addProject), stack(home, newTask())],
    ],
    ["leaving and opening New task again", [stack(home), stack(home, newTask("new-task-2"))]],
  ])("drops a link when its screen loses focus while drafts load: %s", async (_case, states) => {
    const { releaseStorage } = setup();
    openLink(repoLink, stack(home, newTask()));
    for (const state of states) navigate(state);
    releaseStorage();
    await settle();

    expect(drafts()).toEqual([]);
    expect(fixture.dispatched).toEqual([]);
  });

  it("opens only the newer link when one arrives while drafts load", async () => {
    const { releaseStorage } = setup();
    openLink(repoLink, stack(home, newTask()));
    openLink({ ...repoLink, prompt: "The newer prompt" }, stack(home, newTask()));
    releaseStorage();
    await settle();

    expect(drafts()).toEqual([expect.objectContaining({ text: "The newer prompt" })]);
    expect(fixture.dispatched).toHaveLength(1);
  });

  it("opens no thread for a pull request found after leaving", async () => {
    const { releaseStorage } = setup();
    releaseStorage();
    openLink(pullRequestLink, stack(home, newTask()));
    navigate(stack(home));
    answerQuery("pull-request-threads", {
      _tag: "Success",
      value: { threads: [{ id: "thread-1", archivedAt: null }] },
    });
    await settle();

    expect(fixture.dispatched).toEqual([]);
  });

  it("opens no draft for a pull request loaded after leaving", async () => {
    const { releaseStorage } = setup();
    releaseStorage();
    openLink(pullRequestLink, stack(home, newTask()));
    answerQuery("pull-request-threads", { _tag: "Success", value: { threads: [] } });
    await settle();
    navigate(stack(home));
    answerQuery("pull-request-detail", { _tag: "Failure" });
    await settle();

    expect(drafts()).toEqual([]);
    expect(fixture.dispatched).toEqual([]);
  });
});
