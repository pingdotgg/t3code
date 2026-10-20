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
  ProviderInstanceId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import type { Project } from "../../types";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
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
  releaseUploads: vi.fn(),
  clearDraft: vi.fn(),
}));

// Session grants come from the server; each test drives them through these atoms.
vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments })) as never,
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useThreadShells: () => [],
  waitForProjectRemoval: async () => true,
}));
vi.mock(import("~/state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      update: "update",
      delete: "delete",
    } as unknown as typeof actual.projectEnvironment,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "update" | "delete") => state[command]) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ dialogs: { confirm: state.confirm } })) as never,
}));
vi.mock(import("~/lib/composerDraftUploads"), async (original) => ({
  ...(await original()),
  releaseProjectDraftUploads: state.releaseUploads,
}));
// These sections have separate data sources and their own tests.
vi.mock(import("./ProjectDefaultsSettings"), async (original) => ({
  ...(await original()),
  ProjectDefaultsSettings: (() => null) as never,
}));
vi.mock(import("./ProjectActionsSettings"), async (original) => ({
  ...(await original()),
  ProjectActionsSettings: (() => null) as never,
}));

vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  getProjectFileQueryAtom: () => missingProjectFile,
}));

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { ProjectsSettings } from "./ProjectsSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";
import { retainSettingsScope, validateSettingsRouteSearch } from "./settingsScopeNavigation";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex");
const environments = [primaryId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { platform: { machine: "server" } },
  },
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
const missingProjectFile = Atom.make(AsyncResult.initial<never, never>());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup() {
  vi.clearAllMocks();
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
  state.update.mockImplementation(async ({ environmentId, input }) => {
    const { projectId, ...updates } = input;
    const patch = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<Project>;
    state.projects = state.projects.map((project) =>
      project.environmentId === environmentId && project.id === projectId
        ? { ...project, ...patch }
        : project,
    );
    return AsyncResult.success(undefined);
  });
  state.delete.mockResolvedValue(AsyncResult.success(undefined));
  state.confirm.mockResolvedValue(true);
  useComposerDraftStore.setState({ clearProjectDraftThreadId: state.clearDraft });
}

function projectKey() {
  return buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!.projectKey;
}

async function mountPanel(search: Omit<SettingsScopeSearch, "project"> = {}) {
  const key = projectKey();
  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
  });
  const projectsRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "projects",
    component: () => (
      <ProjectSettingsPanel
        projectKey={key}
        environmentId={search.machine ? EnvironmentId.make(search.machine) : null}
        checkoutKey={search.checkout ?? null}
      />
    ),
  });
  const query = new URLSearchParams({ project: key });
  for (const [name, value] of Object.entries(search)) {
    if (value !== undefined) query.set(name, value);
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute.addChildren([projectsRoute])]),
    history: createMemoryHistory({ initialEntries: [`/settings/projects?${query}`] }),
  });
  await router.load();
  // The panel's own route tree validates settings search params, which the default router lacks.
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
      { router: false },
    ),
  );
  await vi.waitFor(() => expect(nameInput(screen)).not.toBeNull());
  stack.move();
  return { ...screen, router };
}

async function mountSettings(search: SettingsScopeSearch) {
  const searchParams = new URLSearchParams(
    Object.entries(search).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
  const route = createRootRoute({
    validateSearch: validateSettingsScopeSearch,
    component: () => (
      <SettingsScopeProvider
        search={route.useSearch()}
        onChange={(next) => void router.navigate({ to: "/settings/projects", search: () => next })}
      >
        <ProjectsSettings />
      </SettingsScopeProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({
      initialEntries: [`/settings/projects?${searchParams.toString()}`],
    }),
  });
  await router.load();
  const screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false },
  );
  return { ...screen, router };
}

const nameInput = (screen: Screen) =>
  screen.container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!;
const removeCheckout = (screen: Screen, root: string) =>
  screen.container.querySelector<HTMLButtonElement>(`[aria-label="Remove checkout ${root}"]`)!;
const removeAll = (screen: Screen) =>
  [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Remove all entries"),
  )!;

async function grant(id: EnvironmentId, result: SessionResult) {
  await act(async () => appAtomRegistry.set(state.sessions.get(id)!, result));
}

async function rename(screen: Screen, title: string) {
  await userEvent.fill(nameInput(screen), title);
  await userEvent.keyboard("{Enter}");
}

describe("project settings permissions", () => {
  it("disables shared edits when any member lacks project access", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    await using screen = await mountPanel();

    expect(nameInput(screen).disabled).toBe(true);
    expect(removeAll(screen).disabled).toBe(true);
    expect(screen.container.textContent).toContain(
      "Shared settings require permission to change every checkout in this group.",
    );
    expect(state.update).not.toHaveBeenCalled();
  });

  it("renames every member when all have project access without settings access", async () => {
    setup();
    await using screen = await mountPanel();
    await rename(screen, "Renamed");
    expect(state.update.mock.calls.map(([request]) => request.environmentId)).toEqual([
      primaryId,
      remoteId,
    ]);
    expect(state.projects.map((project) => project.title)).toEqual(["Renamed", "Renamed"]);
  });

  it("stops before the next member if its grant is revoked during an earlier update", async () => {
    setup();
    const firstUpdate = deferred<AsyncResult.Success<void>>();
    state.update.mockReturnValueOnce(firstUpdate.promise);
    await using screen = await mountPanel();
    await rename(screen, "Renamed");
    expect(state.update).toHaveBeenCalledOnce();

    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      firstUpdate.resolve(AsyncResult.success(undefined));
      await firstUpdate.promise;
    });
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]![0].environmentId).toBe(primaryId);
  });

  it("disables removal for a checkout whose project grant is missing", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    expect(removeCheckout(screen, "/work/remote").disabled).toBe(true);
    expect(removeCheckout(screen, "/work/primary").disabled).toBe(false);
  });

  it("removes a writable checkout while removal of the mixed group stays denied", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    const initialHref = screen.router.state.location.href;
    expect(removeAll(screen).disabled).toBe(true);

    await userEvent.click(removeCheckout(screen, "/work/primary"));
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
    expect(state.delete).toHaveBeenCalledWith({
      environmentId: primaryId,
      input: { projectId: state.projects[0]!.id, force: true },
    });
    await vi.waitFor(() => expect(state.releaseUploads).toHaveBeenCalledOnce());
    expect(state.clearDraft).toHaveBeenCalledOnce();
    expect(screen.router.state.location.href).toBe(initialHref);
  });

  it("rechecks every removal target after confirmation before deleting or clearing drafts", async () => {
    setup();
    const confirmed = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmed.promise);
    await using screen = await mountPanel();
    await userEvent.click(removeAll(screen));
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

  it("does not save an edit whose grant was revoked mid-edit, and recovers when restored", async () => {
    setup();
    await using screen = await mountPanel();
    await userEvent.fill(nameInput(screen), "Renamed");
    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => nameInput(screen).blur());
    expect(state.update).not.toHaveBeenCalled();
    expect(nameInput(screen).disabled).toBe(true);

    await grant(remoteId, writable());
    expect(nameInput(screen).disabled).toBe(false);
    await rename(screen, "Renamed");
    expect(state.projects.map((project) => project.title)).toEqual(["Renamed", "Renamed"]);
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
      setup();
      await grant(remoteId, result());
      await using screen = await mountPanel();
      expect(nameInput(screen).disabled).toBe(!allowed);
      if (!allowed) return;
      await rename(screen, "Renamed");
      expect(state.update).toHaveBeenCalledTimes(2);
    },
  );
});

describe("project settings scope", () => {
  const environmentMenu = () => page.getByRole("button", { name: /^Environment scope:/ });
  const primaryOption = () => page.getByRole("menuitemradio", { name: /^primary/ });
  const remoteOption = () => page.getByRole("menuitemradio", { name: /^remote/ });

  it("offers every environment while no project is selected", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using _screen = await mountSettings({});

    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).toBeVisible();
  });

  it("offers only the selected project's checkout environments", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using _screen = await mountSettings({ project: projectKey() });

    await expect.element(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).not.toBeInTheDocument();
  });

  it("keeps an unknown project recoverable from any environment", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using screen = await mountSettings({ project: "removed-project" });

    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).toBeVisible();
    await userEvent.click(remoteOption());
    await vi.waitFor(() =>
      expect(screen.router.state.location.search).toEqual({
        project: "removed-project",
        machine: remoteId,
      }),
    );
  });

  it.each([
    [undefined, "This project has no checkout on this environment."],
    [
      "removed-checkout",
      "This checkout is no longer available in the selected project and environment.",
    ],
  ])("recovers a stale environment link with checkout %s", async (checkout, message) => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    const key = projectKey();
    await using screen = await mountSettings({
      project: key,
      machine: remoteId,
      ...(checkout ? { checkout } : {}),
    });

    await expect.element(page.getByText(message, { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /^Project scope:/ })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Environment scope: remote" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show all environments" }));

    await expect
      .element(page.getByRole("textbox", { name: "Project name" }))
      .toHaveValue("Shared repo");
    expect(screen.router.state.location.search).toEqual({ project: key });
    await expect
      .element(page.getByRole("button", { name: "Environment scope: All environments" }))
      .toBeVisible();
    await expect.element(page.getByText(message, { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Remove project", exact: true }))
      .toBeEnabled();
  });
});

it("returns to the project overview after removal, clearing the selection but keeping the environment", async () => {
  setup();
  state.projects = [state.projects[1]!];
  await using screen = await mountPanel({ machine: remoteId, checkout: "remote:/work/remote" });
  const removeProject = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove project",
  )!;

  await userEvent.click(removeProject);

  await vi.waitFor(() => {
    expect(screen.router.state.location.pathname).toBe("/settings/projects");
    expect(screen.router.state.location.search).toEqual({ machine: remoteId });
  });
});
