import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const SCRATCH_ROOT = "/home/user/.t3/scratch";

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  folder: "",
  pullRequests: [] as unknown[],
  configLoaded: true,
  /** Repositories the project covers besides its own folder, all on `main`. */
  repositories: [] as string[],
  /** Whether the project tracks `repositories`; false once tracking stopped. */
  tracked: true,
  /** A worktree thread's task folder: each repository's path, keyed to its worktree. */
  taskFolder: null as null | { readonly repositories: ReadonlyArray<[string, string]> },
}));

// The read of t3.json is a cache: a re-read is the only way to see what is on disk now.
const t3File = vi.hoisted(() => ({
  disk: "",
  cached: "",
  listeners: new Set<() => void>(),
}));

vi.mock(import("~/components/files/projectFilesQueryState"), async (importOriginal) => {
  const actual = await importOriginal();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useProjectFileQuery: ((_environmentId: unknown, _cwd: string, relativePath: string | null) => {
      const contents = useSyncExternalStore(
        (listener) => {
          t3File.listeners.add(listener);
          return () => t3File.listeners.delete(listener);
        },
        () => t3File.cached,
      );
      const refresh = () => {
        t3File.cached = t3File.disk;
        for (const listener of t3File.listeners) listener();
      };
      const data =
        relativePath === "t3.json" && contents !== ""
          ? { relativePath, contents, byteLength: contents.length, truncated: false }
          : null;
      return {
        data,
        error: null,
        isPending: false,
        readError: null,
        isNotFile: false,
        isFile: data !== null,
        refresh,
      };
    }) as never,
  };
});

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "project",
          environmentId: "environment",
          title: state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain",
          workspaceRoot: state.workspaceRoot,
          scripts: [],
          trackedFolders: (state.tracked ? state.repositories : []).map((path) => ({
            path,
            name: path.split("/").at(-1)!,
            discovered: true,
          })),
        }) as never,
  useProjects: (() => []) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "thread",
          environmentId: "environment",
          projectId: "project",
          worktreePath: state.folder,
          branch: null,
          pullRequests: state.pullRequests,
        }) as never,
  useServerConfigs: (() =>
    new Map(
      state.configLoaded
        ? [
            [
              EnvironmentId.make("environment"),
              {
                scratchWorkspaceRoot: SCRATCH_ROOT,
                environment: { capabilities: { pullRequests: true } },
              },
            ],
          ]
        : [],
    )) as never,
}));
// Neither folder is a repository, which is what the server reports for both; the project's
// other repositories are.
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const status = (isRepo: boolean) =>
    Atom.make(
      AsyncResult.success({
        isRepo,
        hasPrimaryRemote: false,
        isDefaultRef: isRepo,
        refName: isRepo ? "main" : null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      }),
    );
  const notARepo = status(false);
  const repo = status(true);
  return {
    ...actual,
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      status: ((query: { input: { cwd: string } }) =>
        state.repositories.includes(query.input.cwd) ? repo : notARepo) as never,
    },
  };
});
vi.mock(import("~/state/filesystem"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    filesystemEnvironment: {
      ...actual.filesystemEnvironment,
      taskFolder: (() =>
        Atom.make(
          AsyncResult.success({
            taskFolder:
              state.taskFolder === null
                ? null
                : {
                    root: "/task",
                    projectId: "project",
                    projectRoot: state.workspaceRoot,
                    anchor: state.workspaceRoot,
                    projectPath: state.folder,
                    projectIsWorktree: false,
                    repositories: state.taskFolder.repositories.map(
                      ([repositoryPath, worktreePath]) => ({
                        repositoryPath,
                        worktreePath,
                        name: repositoryPath.split("/").at(-1)!,
                      }),
                    ),
                  },
          }),
        )) as never,
      listFolders: (() =>
        Atom.make(
          AsyncResult.success({
            folders: state.repositories.map((path) => ({
              path,
              name: path.split("/").at(-1)!,
              state: "git" as const,
              discovered: true,
            })),
          }),
        )) as never,
    },
  };
});

import { render } from "../../../test/render";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 27513,
  url: "https://github.com/pingdotgg/t3code/pull/27513",
  source: "manual",
  linkedAt: "2026-10-30T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

function setup(input: {
  workspaceRoot: string;
  folder: string;
  pullRequests?: ThreadPullRequestLink[];
  configLoaded?: boolean;
  repositories?: string[];
}) {
  state.configLoaded = input.configLoaded ?? true;
  state.repositories = input.repositories ?? [];
  state.tracked = true;
  state.taskFolder = null;
  useDiffPanelStore.setState({ gitRepositoryPathByThreadKey: {} });
  state.workspaceRoot = input.workspaceRoot;
  state.folder = input.folder;
  state.pullRequests = input.pullRequests ?? [];
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => anchor.remove(),
  };
}

const machines = (["This Mac", "Server"] as const).map((label, index) => ({
  environmentId: EnvironmentId.make(index === 0 ? "environment" : "other"),
  projectId: ProjectId.make("project"),
  label,
  isPrimary: index === 0,
  machine: "server" as const,
}));

function Panel({
  fixture,
  draftEnvMode,
  onMachines = false,
  withScripts = false,
  inPlace = false,
}: {
  fixture: ReturnType<typeof setup>;
  /** Renders an unsent draft in this mode instead of a started thread. */
  draftEnvMode?: "local" | "worktree";
  onMachines?: boolean;
  withScripts?: boolean;
  /** A started thread that runs in the project folder rather than a worktree. */
  inPlace?: boolean;
}) {
  const noop = () => {};
  const scriptResult = async () => ({ ok: true }) as never;
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: noop,
        measureDetailsCard: noop,
        detailsCardTopInset: 0,
        preferredDetailsCard: placement,
        detailsCardPlacement: placement,
      }}
    >
      <ThreadDetailsPanel
        anchor={fixture.anchor}
        handle={fixture.handle}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        projectId={ProjectId.make("project")}
        composerDraftTarget={threadRef}
        worktreePath={draftEnvMode === undefined && !inPlace ? state.folder : null}
        isServerThread={draftEnvMode === undefined}
        activeProjectName={state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain"}
        activeProjectScripts={withScripts ? [] : undefined}
        preferredScriptId={null}
        keybindings={[]}
        availableEditors={[]}
        showOpenInPicker={false}
        openInShortcutEnabled={false}
        gitCwd={state.folder}
        workspaceMutationId={null}
        isGitRepo={false}
        offersWorkspaceModes={false}
        envLocked={draftEnvMode === undefined}
        availableEnvironments={onMachines ? machines : []}
        {...(onMachines ? { onEnvironmentChange: noop } : {})}
        onEnvModeChange={noop}
        envMode={draftEnvMode ?? "local"}
        startFromOrigin={false}
        onStartFromOriginChange={noop}
        onComposerFocusRequest={noop}
        onRunProjectScript={noop}
        onAddProjectScript={scriptResult}
        onUpdateProjectScript={scriptResult}
        onDeleteProjectScript={scriptResult}
        usage={{} as never}
        taskList={null}
      />
    </ChatCanvasContext>
  );
}

it("offers no git controls in a No project thread, but shows its linked pull request", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("shows Current checkout where no worktree can come from, even when New worktree is the default", async () => {
  using fixture = setup({ workspaceRoot: SCRATCH_ROOT, folder: SCRATCH_ROOT });
  await using _screen = await render(<Panel fixture={fixture} draftEnvMode="worktree" />);
  await expect.element(page.getByLabelText("Run context: Current checkout")).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Run context/ })).not.toBeInTheDocument();
});

it("offers only machines where no worktree can come from and several machines exist", async () => {
  using fixture = setup({ workspaceRoot: SCRATCH_ROOT, folder: SCRATCH_ROOT });
  await using _screen = await render(
    <Panel fixture={fixture} draftEnvMode="worktree" onMachines />,
  );
  await page.getByRole("button", { name: "Run context: This Mac, Current checkout" }).click();
  await expect.element(page.getByText("Run on")).toBeVisible();
  await expect.element(page.getByText("New worktree")).not.toBeInTheDocument();
});

it("shows a linked pull request in a folder that is not a git repository", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
});

it("offers no Initialize Git before the server config says where No project lives", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    configLoaded: false,
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("lists the t3.json actions on disk when the actions menu opens again after the file changed", async () => {
  using fixture = setup({ workspaceRoot: "/work/plain", folder: "/work/plain" });
  const t3Json = (name: string) =>
    JSON.stringify({ scripts: [{ name, command: `npm run dev -- --port ${name.slice(-4)}` }] });
  t3File.disk = t3Json("Dev 4100");
  t3File.cached = t3File.disk;
  await using _screen = await render(<Panel fixture={fixture} withScripts />);

  const chooser = page.getByRole("button", { name: "Choose project action" });
  await chooser.click();
  await expect.element(page.getByRole("menuitem", { name: /Dev 4100/ })).toBeVisible();
  await chooser.click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  // A setup hook rewrites this checkout's t3.json outside T3 Code.
  t3File.disk = t3Json("Dev 4200");

  await chooser.click();
  await expect.element(page.getByRole("menuitem", { name: /Dev 4200/ })).toBeVisible();
});

it("acts in a project's nested repository when its folder is none, and names the one picked", async () => {
  using fixture = setup({
    workspaceRoot: "/work",
    folder: "/work",
    repositories: ["/work/docs/server", "/work/server", "/work/web"],
  });
  await using _screen = await render(<Panel fixture={fixture} inPlace />);
  // Two repositories share a name, so each is named by its folder in the project.
  const picker = page.getByRole("button", { name: "Repository: docs/server" });
  await expect.element(picker).toBeVisible();
  await expect.element(picker.getByText("main")).toBeVisible();
  // The Git actions read the nested repository, not the plain project folder.
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();

  await picker.click();
  await expect.element(page.getByRole("menuitemradio", { name: "plain" })).not.toBeInTheDocument();
  await page.getByRole("menuitemradio", { name: "web" }).click();
  await expect.element(page.getByRole("button", { name: "Repository: web" })).toBeVisible();
});

it("keeps a worktree thread's repositories after the project stops tracking folders", async () => {
  using fixture = setup({ workspaceRoot: "/work", folder: "/task/work" });
  state.tracked = false;
  state.taskFolder = {
    repositories: [
      ["/work/web", "/task/web"],
      ["/work/server", "/task/server"],
    ],
  };
  await using _screen = await render(<Panel fixture={fixture} />);
  // The task folder still holds both worktrees; its plain project folder is no repository.
  const picker = page.getByRole("button", { name: "Repository: web" });
  await expect.element(picker).toBeVisible();
  await picker.click();
  await expect.element(page.getByRole("menuitemradio", { name: "server" })).toBeVisible();
});

it("hides the repository picker when the project covers no other repository", async () => {
  using fixture = setup({ workspaceRoot: "/work/plain", folder: "/work/plain" });
  await using _screen = await render(<Panel fixture={fixture} inPlace />);
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: /^Repository:/ })).not.toBeInTheDocument();
});
