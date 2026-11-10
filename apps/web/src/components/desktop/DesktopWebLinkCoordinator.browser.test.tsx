import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult, type Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  routeParams: {} as Record<string, string>,
  preview: vi.fn(),
  openLink: vi.fn(async () => undefined),
  navigate: vi.fn(async (): Promise<void> => undefined),
  openScratchProject: vi.fn(async () => null),
  confirm: vi.fn(async (_message: string) => true),
  connectPairing: vi.fn(async (_input: { pairingUrl: string }) => ({ _tag: "Success" })),
  localEnvironmentDisabled: false,
}));

// One connected primary environment that can read pull requests. Its project list and
// discovery flag start empty so a test can deliver links before they arrive.
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useRouter: (() => ({
    navigate: state.navigate,
    state: { matches: [{ params: state.routeParams }] },
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => "local" as EnvironmentId,
  usePrimaryEnvironment: (() =>
    state.localEnvironmentDisabled
      ? null
      : {
          environmentId: "local",
          connection: { phase: "connected" },
          serverConfig: {},
        }) as never,
}));
vi.mock(import("../../localEnvironment"), () => ({
  isLocalEnvironmentDisabled: () => state.localEnvironmentDisabled,
}));
vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const capabilities = { pullRequests: true, threadPullRequests: true };
  return {
    ...(await original()),
    environmentServerConfigsAtom: Atom.make(
      new Map([["local", { environment: { capabilities } }]]),
    ) as never,
  };
});
vi.mock(import("../../state/shell"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    allReachableShellsLiveAtom: Atom.make(false).pipe(Atom.keepAlive),
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readProjects: () => state.projects,
  readThreadShell: (ref: { threadId: string }) =>
    ref.threadId === "thread" ? ({ projectId: "effect", worktreePath: null } as never) : null,
  readProject: () => state.projects[0] ?? null,
}));
vi.mock(import("../../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: (() => ({
    scratchEnvironmentId: () => "local",
    openScratchProject: state.openScratchProject,
  })) as never,
}));

vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => state.preview,
}));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => state.openLink }));
vi.mock(import("../../confirmDialog"), async (original) => ({
  ...(await original()),
  requestConfirmDialog: state.confirm,
}));
vi.mock(import("../../connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: "connectPairing" as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: unknown, options: never) =>
      command === "connectPairing"
        ? state.connectPairing
        : actual.useAtomCommand(command as never, options)) as never,
  };
});

import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { allReachableShellsLiveAtom } from "../../state/shell";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../../diffPanelStore";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";

const discoverySettled = allReachableShellsLiveAtom as Atom.Writable<boolean>;
const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("effect");
const project = {
  id: projectId,
  workspaceRoot: "/workspace/effect",
  environmentId,
  repositoryIdentity: {
    provider: "github",
    displayName: "Effect-TS/effect",
    canonicalKey: "github.com/effect-ts/effect",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/Effect-TS/effect.git",
    },
  },
} as EnvironmentProject;
const pullRequestUrl = "https://github.com/Effect-TS/effect/pull/9339";
const pullRequestView = {
  to: "/pull-requests",
  search: {
    involvement: "all",
    state: "all",
    repository: "effect-ts/effect",
    number: 9339,
    selectedHost: "github.com",
    selectedProjectId: projectId,
    selectedEnvironmentId: environmentId,
  },
};

const pairingUrl = "https://vps.example.com/pair#token=ABC123";
const pairLink = `t3code://pair?pairingUrl=${encodeURIComponent(pairingUrl)}`;

function setup() {
  vi.clearAllMocks();
  state.confirm.mockResolvedValue(true);
  state.localEnvironmentDisabled = false;
  state.projects = [];
  state.routeParams = {};
  state.preview
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ sources: [{ kind: "commit", headRef: sha }] }));
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  appAtomRegistry.set(discoverySettled, false);
}

/** Mounts the coordinator behind a desktop bridge that hands over `urls` once the renderer is ready. */
async function mount(...urls: string[]) {
  let deliver: ((url: string) => void) | undefined;
  await using stack = new AsyncDisposableStack();
  stack.use(
    stubGlobal("desktopBridge", {
      getClientSettings: async () => null,
      webLinks: {
        onOpen: (listener: (url: string) => void) => {
          deliver = listener;
          return () => undefined;
        },
        setReady: async (ready: boolean) => {
          if (ready) for (const url of urls.splice(0)) deliver?.(url);
        },
      },
    }),
  );
  stack.use(
    await render(
      <AppAtomRegistryProvider>
        <DesktopWebLinkCoordinator />
      </AppAtomRegistryProvider>,
    ),
  );
  return stack.move();
}

it("holds a launch PR link until project discovery settles, then opens the PR view", async () => {
  setup();
  await using _coordinator = await mount(pullRequestUrl);
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.openScratchProject).not.toHaveBeenCalled();

  state.projects = [project];
  const navigated = new Promise<void>((resolve) => {
    state.navigate.mockImplementationOnce(async () => resolve());
  });
  await act(async () => {
    appAtomRegistry.set(discoverySettled, true);
    await navigated;
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith(pullRequestView);
  expect(state.openScratchProject).not.toHaveBeenCalled();
});

const sha = "a".repeat(40);
const commitUrl = `https://github.com/Effect-TS/effect/pull/9339/commits/${sha}`;
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));

it.each([
  ["github.com", "pull/9339/commits"],
  ["code.example.com:8443", "commit"],
])("opens a %s/%s commit in the active thread's Diff pane after discovery", async (host, path) => {
  setup();
  state.routeParams = { environmentId: "local", threadId: "thread" };
  await using _coordinator = await mount(`https://${host}/Effect-TS/effect/${path}/${sha}`);
  expect(state.preview).not.toHaveBeenCalled();

  state.projects = [
    {
      ...project,
      repositoryIdentity: {
        ...project.repositoryIdentity,
        canonicalKey: `${host}/effect-ts/effect`,
        locator: {
          ...project.repositoryIdentity?.locator,
          remoteUrl: `https://${host}/Effect-TS/effect.git`,
        },
      },
    } as EnvironmentProject,
  ];
  await act(async () => appAtomRegistry.set(discoverySettled, true));
  await vi.waitFor(() => {
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
      "diff",
    );
  });
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({ kind: "commit", sha });
  expect(state.preview).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: expect.objectContaining({ cwd: "/workspace/effect", commitSha: sha }),
  });
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.openLink).not.toHaveBeenCalled();
});

it("opens a PR commit the workspace lacks in the thread's PR panel", async () => {
  setup();
  state.routeParams = { environmentId: "local", threadId: "thread" };
  state.projects = [project];
  state.preview.mockResolvedValueOnce(AsyncResult.success({ sources: [] }));
  appAtomRegistry.set(discoverySettled, true);
  await using _coordinator = await mount(commitUrl);
  await vi.waitFor(() =>
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "pull-request", repository: "effect-ts/effect", number: 9339 }),
  );
  expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
  expect(state.openLink).not.toHaveBeenCalled();
});

it("opens a plain commit the workspace lacks like any other delivered link", async () => {
  setup();
  state.routeParams = { environmentId: "local", threadId: "thread" };
  state.projects = [project];
  state.preview.mockResolvedValueOnce(AsyncResult.success({ sources: [] }));
  appAtomRegistry.set(discoverySettled, true);
  const plainCommitUrl = `https://github.com/Effect-TS/effect/commit/${sha}`;
  await using _coordinator = await mount(plainCommitUrl);
  await vi.waitFor(() => expect(state.openScratchProject).toHaveBeenCalledOnce());
  // Handing it to the OS browser would loop when T3 Code is the default browser.
  expect(state.openLink).not.toHaveBeenCalled();
  expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
});

it("adds the backend from a pairing link after the user confirms its host", async () => {
  setup();
  await using _coordinator = await mount(pairLink);
  await vi.waitFor(() =>
    expect(state.connectPairing).toHaveBeenCalledExactlyOnceWith({ pairingUrl }),
  );
  expect(state.confirm).toHaveBeenCalledExactlyOnceWith(
    "Add the backend at https://vps.example.com?",
  );
  expect(state.navigate).not.toHaveBeenCalled();
});

it("does not spend the pairing token when the user declines", async () => {
  setup();
  const otherPairingUrl = "https://other.example.com/pair#token=XYZ789";
  state.confirm.mockResolvedValueOnce(false);
  await using _coordinator = await mount(
    pairLink,
    `t3code://pair?pairingUrl=${encodeURIComponent(otherPairingUrl)}`,
  );
  await vi.waitFor(() => expect(state.connectPairing).toHaveBeenCalled());
  expect(state.confirm).toHaveBeenCalledTimes(2);
  expect(state.connectPairing).toHaveBeenCalledExactlyOnceWith({ pairingUrl: otherPairingUrl });
});

it("skips a repeat of a pairing link that already paired", async () => {
  setup();
  const otherPairingUrl = "https://other.example.com/pair#token=XYZ789";
  await using _coordinator = await mount(
    pairLink,
    pairLink,
    `t3code://pair?pairingUrl=${encodeURIComponent(otherPairingUrl)}`,
  );
  await vi.waitFor(() =>
    expect(state.connectPairing).toHaveBeenLastCalledWith({ pairingUrl: otherPairingUrl }),
  );
  expect(state.confirm).toHaveBeenCalledTimes(2);
  expect(state.connectPairing.mock.calls).toEqual([
    [{ pairingUrl }],
    [{ pairingUrl: otherPairingUrl }],
  ]);
});

it("pairs with Local environment disabled, where there is no primary environment to wait for", async () => {
  setup();
  state.localEnvironmentDisabled = true;
  await using _coordinator = await mount(pairLink);
  await vi.waitFor(() =>
    expect(state.connectPairing).toHaveBeenCalledExactlyOnceWith({ pairingUrl }),
  );
});

it("holds a launch PR link with Local environment disabled until discovery settles", async () => {
  setup();
  state.localEnvironmentDisabled = true;
  await using _coordinator = await mount(pullRequestUrl);
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.openScratchProject).not.toHaveBeenCalled();

  state.projects = [project];
  const navigated = new Promise<void>((resolve) => {
    state.navigate.mockImplementationOnce(async () => resolve());
  });
  await act(async () => {
    appAtomRegistry.set(discoverySettled, true);
    await navigated;
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith(pullRequestView);
  expect(state.openScratchProject).not.toHaveBeenCalled();
});
