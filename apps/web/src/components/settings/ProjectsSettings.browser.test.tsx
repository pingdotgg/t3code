import { RegistryContext } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: () => writableSession,
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments })) as never,
  readEnvironment: ((id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id) ?? null) as never,
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useThreadShells: () => [],
  useServerConfigs: (() =>
    new Map(
      environments.map((environment) => [environment.environmentId, environment.serverConfig]),
    )) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
      upsertKeybinding: "upsertKeybinding",
      removeKeybinding: "removeKeybinding",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "updateSettings" | "upsertKeybinding" | "removeKeybinding") =>
    state[command]) as never,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { ProjectsSettings } from "./ProjectsSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";

const primaryId = EnvironmentId.make("primary");
const environments = [
  {
    environmentId: primaryId,
    label: "primary",
    connection: { phase: "connected" },
    serverConfig: {
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { platform: { machine: "server" }, capabilities: { projectOrganization: true } },
    },
  },
];
const writableSession = Atom.make(
  AsyncResult.success<AuthSessionState>({
    authenticated: true,
    scopes: [AuthSettingsWriteScope],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  }),
).pipe(Atom.keepAlive);

function setup() {
  vi.clearAllMocks();
  for (const command of [state.updateSettings, state.upsertKeybinding, state.removeKeybinding])
    command.mockResolvedValue(AsyncResult.success(undefined));
  state.projects = [
    {
      id: ProjectId.make("project"),
      environmentId: primaryId,
      title: "Repo",
      workspaceRoot: "/work/repo",
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    },
  ];
}

async function mountSettings(search: SettingsScopeSearch) {
  const query = new URLSearchParams(
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
    history: createMemoryHistory({ initialEntries: [`/settings/projects?${query}`] }),
  });
  await router.load();
  // The settings route validates scope search params, which the default router lacks.
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false },
  );
}

describe("all-projects actions", () => {
  it.each([
    ["all environments", {}],
    ["one environment", { machine: primaryId }],
  ] as const)(
    "adds a default action for every project on %s",
    async (_scope, search: SettingsScopeSearch) => {
      setup();
      await using _screen = await mountSettings(search);

      await expect.element(page.getByRole("button", { name: /^Environment scope:/ })).toBeVisible();
      const addAction = page.getByRole("button", { name: "Add action" });
      expect(addAction.query(), "all-projects scope has no Add action button").not.toBeNull();
      await userEvent.click(addAction);
      await userEvent.fill(page.getByRole("textbox", { name: "Command" }), "vp test");
      await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Test");
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => expect(state.updateSettings).toHaveBeenCalledOnce());
      expect(state.updateSettings).toHaveBeenCalledWith({
        environmentId: primaryId,
        input: {
          patch: {
            defaultProjectScripts: [expect.objectContaining({ name: "Test", command: "vp test" })],
          },
        },
      });
    },
  );
});
