import {
  ALL_TEAM_ROLES,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  TeamProviderId,
  TeamViewId,
  type TeamInviteCreatedResult,
  type TeamProvider,
  type TeamPseudo,
  type TeamView,
} from "@t3tools/contracts";
import type { TeamEnvironmentState } from "@t3tools/client-runtime/team";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { TeamsSettings } from "./TeamsSettings";

const envA = EnvironmentId.make("env-team-a");
const envB = EnvironmentId.make("env-team-b");
const envC = EnvironmentId.make("env-team-c");
const urlA = "https://team-a.example.com";
const urlB = "https://team-b.example.com";
const urlC = "https://team-c.example.com";

const makeTeamState = (
  id: string,
  name: string,
  pseudo: string,
  role: "owner" | "regular" = "owner",
): TeamEnvironmentState => {
  const teamId = TeamId.make(`team-${id}`);
  const memberId = TeamMemberId.make(`member-${id}`);
  const member = {
    id: memberId,
    teamId,
    pseudo: pseudo as TeamPseudo,
    role,
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const defaultViewId = TeamViewId.make(`view-${id}`);
  const defaultView: TeamView = {
    id: defaultViewId,
    teamId,
    name: "Default",
    description: null,
    isDefault: true,
    readRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
    postRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    team: {
      id: teamId,
      name,
      defaultViewId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    currentMember: member,
    members: [member],
    views: [defaultView],
    invites: [],
    threadAttributions: [],
    snoozedByThreadId: new Map(),
    followedThreadIds: new Set(),
    latestTurnByThreadId: new Map(),
    turnAuthorByTurnId: new Map(),
    memberById: new Map([[memberId, member]]),
    viewById: new Map([[defaultViewId, defaultView]]),
    attributionByThreadId: new Map(),
    teamProjects: [],
    projectAssignmentByProjectId: new Map(),
    projectAssignmentByRepoKey: new Map(),
    environments: [],
    environmentById: new Map(),
    threadNotesByThreadId: new Map(),
    providers: [],
    skills: [],
    preprompts: [],
    assetsRevision: 0,
    myGitHubIdentity: null,
    automationGitHubIdentity: null,
    githubAppConfig: null,
    scheduledTaskMetas: [],
    scheduledTaskMetaByTaskId: new Map(),
    queuedMessageNotifications: [],
  };
};

const teamStateA = makeTeamState("a", "Team Alpha", "alice", "owner");
const teamStateB = makeTeamState("b", "Team Beta", "alice", "owner");
const teamStateC = makeTeamState("c", "Team Gamma", "bob", "regular");

const mockState = vi.hoisted(() => ({
  createInviteHandler:
    vi.fn<
      (args: {
        readonly environmentId: EnvironmentId;
        readonly input: unknown;
      }) => Promise<AsyncResult.AsyncResult<TeamInviteCreatedResult, unknown>>
    >(),
  updateMobileVisibilityHandler: vi.fn(),
  createMobilePairingHandler: vi.fn(),
  listMobilePairingsHandler: vi.fn(),
  revokeMobilePairingHandler: vi.fn(),
  setGitHubAppConfigHandler: vi.fn(),
  clearGitHubAppConfigHandler: vi.fn(),
  startGitHubOAuthHandler: vi.fn(),
  completeGitHubOAuthHandler: vi.fn(),
  startGitHubDeviceFlowHandler: vi.fn(),
  pollGitHubDeviceFlowHandler: vi.fn(),
  cancelGitHubDeviceFlowHandler: vi.fn(),
  leaveTeamHandler: vi.fn(),
  deleteTeamHandler: vi.fn(),
  removeLocalBindingHandler: vi.fn(),
  removeEnvironmentHandler: vi.fn(),
  confirmDialogHandler: vi.fn<(message: string, options?: unknown) => Promise<boolean>>(),
}));

const alwaysAllowedAtom = Atom.make(true);

vi.mock(import("../../confirmDialog"), async (original) => ({
  ...(await original()),
  requestConfirmDialog: ((message: string, options?: unknown) =>
    mockState.confirmDialogHandler(message, options)) as never,
}));

vi.mock(import("../../connection/catalog"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      remove: { tag: "environmentCatalog.remove" },
    } as never,
  };
});

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => new Map(),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: envA,
        label: "Server A",
        displayUrl: urlA,
        connection: { phase: "connected" },
      },
      {
        environmentId: envB,
        label: "Server B",
        displayUrl: urlB,
        connection: { phase: "connected" },
      },
      {
        environmentId: envC,
        label: "Server C",
        displayUrl: urlC,
        connection: { phase: "connected" },
      },
    ],
  })) as never,
  usePrimaryEnvironmentId: (() => envA) as never,
  useEnvironmentHttpBaseUrl: ((environmentId: EnvironmentId | null) =>
    environmentId === envA
      ? urlA
      : environmentId === envB
        ? urlB
        : environmentId === envC
          ? urlC
          : null) as never,
}));

vi.mock(import("../../state/team"), async (original) => ({
  ...(await original()),
  useShowColleaguesThreads: () => false,
  useTeamStatesByEnvironment: () =>
    new Map<EnvironmentId, TeamEnvironmentState>([
      [envA, teamStateA],
      [envB, teamStateB],
      [envC, teamStateC],
    ]),
  useTeamEnvironmentState: (environmentId: EnvironmentId | null) =>
    environmentId === envC ? teamStateC : environmentId === envB ? teamStateB : teamStateA,
  teamEnvironment: {
    initialize: { tag: "initialize", permissionAtom: () => alwaysAllowedAtom },
    updateMyPseudo: { tag: "updateMyPseudo", permissionAtom: () => alwaysAllowedAtom },
    leave: { tag: "leave", permissionAtom: () => alwaysAllowedAtom },
    deleteTeam: { tag: "deleteTeam", permissionAtom: () => alwaysAllowedAtom },
    removeLocalBinding: { tag: "removeLocalBinding", permissionAtom: () => alwaysAllowedAtom },
    createInvite: { tag: "createInvite", permissionAtom: () => alwaysAllowedAtom },
    revokeInvite: { tag: "revokeInvite", permissionAtom: () => alwaysAllowedAtom },
    updateMemberRole: { tag: "updateMemberRole", permissionAtom: () => alwaysAllowedAtom },
    updateMemberStatus: { tag: "updateMemberStatus", permissionAtom: () => alwaysAllowedAtom },
    createView: { tag: "createView", permissionAtom: () => alwaysAllowedAtom },
    updateView: { tag: "updateView", permissionAtom: () => alwaysAllowedAtom },
    deleteView: { tag: "deleteView", permissionAtom: () => alwaysAllowedAtom },
    setThreadView: { tag: "setThreadView", permissionAtom: () => alwaysAllowedAtom },
    setThreadLocked: { tag: "setThreadLocked", permissionAtom: () => alwaysAllowedAtom },
    attachEnvironment: { tag: "attachEnvironment", permissionAtom: () => alwaysAllowedAtom },
    updateEnvironment: { tag: "updateEnvironment", permissionAtom: () => alwaysAllowedAtom },
    detachEnvironment: { tag: "detachEnvironment", permissionAtom: () => alwaysAllowedAtom },
    upsertProvider: { tag: "upsertProvider", permissionAtom: () => alwaysAllowedAtom },
    deleteProvider: { tag: "deleteProvider", permissionAtom: () => alwaysAllowedAtom },
    listProviderUsage: { tag: "listProviderUsage", permissionAtom: () => alwaysAllowedAtom },
    upsertSkill: { tag: "upsertSkill", permissionAtom: () => alwaysAllowedAtom },
    deleteSkill: { tag: "deleteSkill", permissionAtom: () => alwaysAllowedAtom },
    upsertPreprompt: { tag: "upsertPreprompt", permissionAtom: () => alwaysAllowedAtom },
    deletePreprompt: { tag: "deletePreprompt", permissionAtom: () => alwaysAllowedAtom },
    updateMyMobileVisibility: {
      tag: "updateMyMobileVisibility",
      permissionAtom: () => alwaysAllowedAtom,
    },
    createMobilePairingLink: {
      tag: "createMobilePairingLink",
      permissionAtom: () => alwaysAllowedAtom,
    },
    listMyMobilePairingLinks: {
      tag: "listMyMobilePairingLinks",
      permissionAtom: () => alwaysAllowedAtom,
    },
    revokeMyMobilePairingLink: {
      tag: "revokeMyMobilePairingLink",
      permissionAtom: () => alwaysAllowedAtom,
    },
    connectMyGitHub: { tag: "connectMyGitHub", permissionAtom: () => alwaysAllowedAtom },
    disconnectMyGitHub: { tag: "disconnectMyGitHub", permissionAtom: () => alwaysAllowedAtom },
    setAutomationGitHub: { tag: "setAutomationGitHub", permissionAtom: () => alwaysAllowedAtom },
    clearAutomationGitHub: {
      tag: "clearAutomationGitHub",
      permissionAtom: () => alwaysAllowedAtom,
    },
    setGitHubAppConfig: { tag: "setGitHubAppConfig", permissionAtom: () => alwaysAllowedAtom },
    clearGitHubAppConfig: { tag: "clearGitHubAppConfig", permissionAtom: () => alwaysAllowedAtom },
    startGitHubOAuth: { tag: "startGitHubOAuth", permissionAtom: () => alwaysAllowedAtom },
    completeGitHubOAuth: { tag: "completeGitHubOAuth", permissionAtom: () => alwaysAllowedAtom },
    startGitHubDeviceFlow: {
      tag: "startGitHubDeviceFlow",
      permissionAtom: () => alwaysAllowedAtom,
    },
    pollGitHubDeviceFlow: { tag: "pollGitHubDeviceFlow", permissionAtom: () => alwaysAllowedAtom },
    cancelGitHubDeviceFlow: {
      tag: "cancelGitHubDeviceFlow",
      permissionAtom: () => alwaysAllowedAtom,
    },
  } as never,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => {
    const mock = vi.fn(async (args: { environmentId: EnvironmentId; input: unknown }) => {
      const tag =
        command && typeof command === "object" && "tag" in command
          ? (command as { readonly tag?: string }).tag
          : undefined;
      if (tag === "createInvite") {
        return mockState.createInviteHandler(args);
      }
      if (tag === "updateMyMobileVisibility") {
        return mockState.updateMobileVisibilityHandler(args);
      }
      if (tag === "createMobilePairingLink") {
        return mockState.createMobilePairingHandler(args);
      }
      if (tag === "listMyMobilePairingLinks") {
        return (
          mockState.listMobilePairingsHandler(args) ?? AsyncResult.success({ pairingLinks: [] })
        );
      }
      if (tag === "revokeMyMobilePairingLink") {
        return mockState.revokeMobilePairingHandler(args);
      }
      if (tag === "setGitHubAppConfig") {
        return mockState.setGitHubAppConfigHandler(args);
      }
      if (tag === "clearGitHubAppConfig") {
        return mockState.clearGitHubAppConfigHandler(args);
      }
      if (tag === "startGitHubOAuth") {
        return mockState.startGitHubOAuthHandler(args);
      }
      if (tag === "completeGitHubOAuth") {
        return mockState.completeGitHubOAuthHandler(args);
      }
      if (tag === "startGitHubDeviceFlow") {
        return mockState.startGitHubDeviceFlowHandler(args);
      }
      if (tag === "pollGitHubDeviceFlow") {
        return mockState.pollGitHubDeviceFlowHandler(args);
      }
      if (tag === "cancelGitHubDeviceFlow") {
        return mockState.cancelGitHubDeviceFlowHandler(args);
      }
      if (tag === "leave") {
        return mockState.leaveTeamHandler(args);
      }
      if (tag === "deleteTeam") {
        return mockState.deleteTeamHandler(args);
      }
      if (tag === "removeLocalBinding") {
        return mockState.removeLocalBindingHandler(args);
      }
      if (tag === "environmentCatalog.remove") {
        return mockState.removeEnvironmentHandler(args);
      }
      return AsyncResult.success(undefined);
    });
    return mock;
  }) as never,
}));

const makeInviteResult = (token: string): TeamInviteCreatedResult => ({
  token,
  invite: {
    id: TeamInviteId.make(`invite-${token}`),
    teamId: teamStateA.team!.id,
    role: "regular",
    prefilledPseudo: null,
    maxUses: 1,
    uses: 0,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdByMemberId: teamStateA.currentMember!.id,
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});

describe("TeamsSettings", () => {
  it("scopes generated invite links to their originating server after switching servers", async () => {
    mockState.createInviteHandler.mockResolvedValueOnce(
      AsyncResult.success(makeInviteResult("t3team_server_a_after")),
    );

    await using screen = await render(<TeamsSettings />);

    await screen.getByTestId("team-invite-open-form").click();
    await screen.getByTestId("team-invite-create").click();
    await expect.element(screen.getByTestId("team-invite-generated")).toBeVisible();
    await expect
      .element(screen.getByTestId("team-invite-deeplink"))
      .toHaveValue(
        `t3code://team/join?server=${encodeURIComponent(urlA)}&token=t3team_server_a_after`,
      );

    await screen.getByTestId("team-server-select").click();
    await screen.getByRole("option", { name: /Server B/ }).click();

    expect(screen.getByTestId("team-invite-generated").query()).toBeNull();

    await screen.getByTestId("team-server-select").click();
    await screen.getByRole("option", { name: /Server A/ }).click();

    await expect.element(screen.getByTestId("team-invite-generated")).toBeVisible();
    await expect
      .element(screen.getByTestId("team-invite-deeplink"))
      .toHaveValue(
        `t3code://team/join?server=${encodeURIComponent(urlA)}&token=t3team_server_a_after`,
      );
  });

  it("never pairs server A's pending invite token with server B's URL when switching mid-flight", async () => {
    let resolveInvite!: (value: AsyncResult.AsyncResult<TeamInviteCreatedResult, unknown>) => void;
    mockState.createInviteHandler.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInvite = resolve;
        }),
    );

    await using screen = await render(<TeamsSettings />);

    await screen.getByTestId("team-invite-open-form").click();
    await screen.getByTestId("team-invite-create").click();

    await screen.getByTestId("team-server-select").click();
    await screen.getByRole("option", { name: /Server B/ }).click();

    resolveInvite(AsyncResult.success(makeInviteResult("t3team_server_a_inflight")));
    // Switching servers resets transient form state; reopening on Server B shows an enabled button.
    await screen.getByTestId("team-invite-open-form").click();
    await expect.element(screen.getByTestId("team-invite-create")).toBeEnabled();

    expect(screen.getByTestId("team-invite-generated").query()).toBeNull();

    await screen.getByTestId("team-server-select").click();
    await screen.getByRole("option", { name: /Server A/ }).click();

    await expect.element(screen.getByTestId("team-invite-generated")).toBeVisible();
    await expect
      .element(screen.getByTestId("team-invite-deeplink"))
      .toHaveValue(
        `t3code://team/join?server=${encodeURIComponent(urlA)}&token=t3team_server_a_inflight`,
      );
  });

  it("generates a member-bound mobile pairing code and updates mobile visibility preference", async () => {
    mockState.createMobilePairingHandler.mockResolvedValueOnce(
      AsyncResult.success({
        id: "pair-mobile-1",
        credential: "ABCD-EFGH-IJKL",
        label: "Alice iPhone",
        scopes: [],
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    mockState.updateMobileVisibilityHandler.mockResolvedValueOnce(
      AsyncResult.success({
        ...teamStateA.currentMember!,
        upstreamClientThreadVisibility: "all_accessible",
      }),
    );

    await using screen = await render(<TeamsSettings />);

    await expect.element(screen.getByTestId("team-mobile-compat-section")).toBeVisible();
    await screen.getByTestId("team-mobile-pairing-label-input").fill("Alice iPhone");
    await screen.getByTestId("team-mobile-pairing-create").click();

    await expect.element(screen.getByTestId("team-mobile-pairing-generated")).toBeVisible();
    await expect
      .element(screen.getByTestId("team-mobile-pairing-code"))
      .toHaveValue("ABCD-EFGH-IJKL");
    await expect.element(screen.getByTestId("team-mobile-pairing-qr")).toBeVisible();

    await screen.getByTestId("team-mobile-visibility-select").click();
    await screen.getByRole("option", { name: "All accessible team threads" }).click();

    expect(mockState.updateMobileVisibilityHandler).toHaveBeenCalledWith({
      environmentId: envA,
      input: { upstreamClientThreadVisibility: "all_accessible" },
    });
  });

  it("shows member GitHub identity controls for all roles, restricts team automation GitHub to owner/admin, and clears unsaved PAT inputs on server switch", async () => {
    await using screen = await render(<TeamsSettings />);
    await screen.getByTestId("teams-tab-providers").click();

    // Server A is owner -> sees both personal member GitHub identity and admin-only automation account.
    const tokenInputA = screen.getByTestId("team-my-github-token-input");
    await expect.element(tokenInputA).toBeVisible();
    await expect.element(screen.getByTestId("team-automation-github-token-input")).toBeVisible();
    await tokenInputA.fill("github_pat_server_a_unsaved");
    await expect.element(tokenInputA).toHaveValue("github_pat_server_a_unsaved");

    // Switch to Server C where current member is regular -> unsaved PAT is cleared, personal GitHub shown, automation hidden.
    await screen.getByTestId("team-server-select").click();
    await screen.getByRole("option", { name: /Server C/ }).click();

    const tokenInputC = screen.getByTestId("team-my-github-token-input");
    await expect.element(tokenInputC).toBeVisible();
    await expect.element(tokenInputC).toHaveValue("");
    expect(screen.getByTestId("team-automation-github-token-input").query()).toBeNull();
  });

  it("lets owner configure GitHub App OAuth with callback URL helper, hides admin form from regular members, and surfaces one-click OAuth, device code, and reconnect required states", async () => {
    mockState.setGitHubAppConfigHandler.mockReset().mockResolvedValueOnce(
      AsyncResult.success({
        enabled: true,
        mode: "github_app",
        clientId: "Iv1.testapp",
        webBaseUrl: "https://github.com",
        apiBaseUrl: "https://api.github.com",
        scopes: "",
        hasClientSecret: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    mockState.startGitHubDeviceFlowHandler.mockReset().mockResolvedValueOnce(
      AsyncResult.success({
        deviceFlowId: "ghdev_test_1",
        userCode: "WXYZ-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: "2099-01-01T00:00:00.000Z",
        intervalSeconds: 30,
      }),
    );
    mockState.cancelGitHubDeviceFlowHandler
      .mockReset()
      .mockResolvedValueOnce(AsyncResult.success({ cancelled: true }));

    const prevConfigC = teamStateC.githubAppConfig;
    const prevIdentityC = teamStateC.myGitHubIdentity;
    (teamStateC as { githubAppConfig: TeamEnvironmentState["githubAppConfig"] }).githubAppConfig = {
      enabled: true,
      mode: "github_app",
      clientId: "Iv1.gamma",
      webBaseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      scopes: "",
      hasClientSecret: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    (
      teamStateC as { myGitHubIdentity: TeamEnvironmentState["myGitHubIdentity"] }
    ).myGitHubIdentity = {
      authMethod: "github_app",
      githubLogin: "bob-gh",
      githubName: "Bob Dev",
      githubEmail: "bob@example.com",
      apiBaseUrl: "https://api.github.com",
      connectedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      needsReconnect: true,
      reconnectReason: "GitHub authorization was revoked.",
    };

    try {
      await using screen = await render(<TeamsSettings />);
      await screen.getByTestId("teams-tab-providers").click();

      // Owner on Server A sees the GitHub OAuth / GitHub App configuration form & callback URL helper,
      // and OAuth scopes input is hidden in github_app mode.
      await expect
        .element(screen.getByTestId("team-github-app-callback-url"))
        .toHaveValue(`${urlA}/api/team/github/oauth/callback`);
      expect(screen.getByTestId("team-github-app-scopes-input").query()).toBeNull();
      await screen.getByTestId("team-github-app-client-id-input").fill("Iv1.testapp");
      await screen.getByTestId("team-github-app-client-secret-input").fill("secret_123");
      await screen.getByTestId("team-github-app-save").click();

      expect(mockState.setGitHubAppConfigHandler).toHaveBeenCalledWith({
        environmentId: envA,
        input: expect.objectContaining({
          mode: "github_app",
          clientId: "Iv1.testapp",
          clientSecret: "secret_123",
          enabled: true,
        }),
      });

      // Switch to Server C (regular member) -> admin OAuth config form is hidden,
      // member sees Reconnect required badge/banner + Sign in with GitHub + Use device code,
      // shared Git commit author toggle is visible, and PAT form is collapsed behind a disclosure.
      await screen.getByTestId("team-server-select").click();
      await screen.getByRole("option", { name: /Server C/ }).click();

      expect(screen.getByTestId("team-github-app-form").query()).toBeNull();
      await expect
        .element(screen.getByTestId("team-my-github-status"))
        .toHaveTextContent("Reconnect required");
      await expect
        .element(screen.getByTestId("team-my-github-reconnect-banner"))
        .toHaveTextContent("GitHub authorization was revoked.");
      await expect.element(screen.getByTestId("team-my-github-oauth-signin")).toBeVisible();
      await expect.element(screen.getByTestId("team-my-github-author-toggle")).toBeVisible();
      await expect.element(screen.getByTestId("team-my-github-pat-disclosure")).toBeVisible();
      expect(screen.getByTestId("team-my-github-token-input").query()).toBeNull();

      // Start device code flow and verify user code renders and can be cancelled cleanly.
      await screen.getByTestId("team-my-github-device-signin").click();
      await expect
        .element(screen.getByTestId("team-my-github-device-code"))
        .toHaveTextContent("WXYZ-1234");
      await screen.getByTestId("team-my-github-device-cancel").click();
      expect(mockState.cancelGitHubDeviceFlowHandler).toHaveBeenCalledWith({
        environmentId: envC,
        input: { deviceFlowId: "ghdev_test_1" },
      });
    } finally {
      (teamStateC as { githubAppConfig: TeamEnvironmentState["githubAppConfig"] }).githubAppConfig =
        prevConfigC;
      (
        teamStateC as { myGitHubIdentity: TeamEnvironmentState["myGitHubIdentity"] }
      ).myGitHubIdentity = prevIdentityC;
    }
  });

  it("renders human-readable SelectValue labels, locked edit ID, clearSecret switch, and collapsed manual OAuth in Providers & Skills tabs", async () => {
    const existingProvider: TeamProvider = {
      id: TeamProviderId.make("provider-claude-main"),
      teamId: teamStateA.team!.id,
      providerInstanceId: ProviderInstanceId.make("team-claude-main"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Team Claude",
      deliveryStrategy: "token-lease",
      upstreamBaseUrl: null,
      apiKeyHeader: null,
      apiKeyPrefix: null,
      hasSecret: true,
      config: {},
      enabled: true,
      updatedByMemberId: teamStateA.currentMember!.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const prevProvidersA = teamStateA.providers;
    (teamStateA as { providers: ReadonlyArray<TeamProvider> }).providers = [existingProvider];

    try {
      await using screen = await render(<TeamsSettings />);

      // Providers tab: open creation form and verify human-readable <SelectValue> labels (never raw IDs).
      await screen.getByTestId("teams-tab-providers").click();
      await screen.getByTestId("team-provider-add-open").click();
      await expect
        .element(screen.getByTestId("team-provider-driver-select"))
        .toHaveTextContent("Claude Code");
      await expect
        .element(screen.getByTestId("team-provider-strategy-select"))
        .toHaveTextContent("Token lease (OAuth)");

      // Edit existing token-lease provider -> ID input is disabled, clearSecret switch is shown,
      // and manual OAuth inputs are collapsed by default.
      await screen.getByTestId("team-provider-edit-team-claude-main").click();
      await expect.element(screen.getByTestId("team-provider-id-input")).toBeDisabled();
      await expect
        .element(screen.getByTestId("team-provider-strategy-select"))
        .toHaveTextContent("Token lease (OAuth)");
      await expect.element(screen.getByTestId("team-provider-clear-secret-switch")).toBeVisible();
      expect(screen.getByTestId("team-provider-manual-oauth-fields").query()).toBeNull();
      await screen.getByTestId("team-provider-manual-oauth-toggle").click();
      await expect.element(screen.getByTestId("team-provider-manual-oauth-fields")).toBeVisible();

      // Skills & Pre-prompts tab: verify human-readable <SelectValue> labels.
      await screen.getByTestId("teams-tab-skills").click();
      await screen.getByTestId("team-skill-add-open").click();
      await expect
        .element(screen.getByTestId("team-skill-driver-select"))
        .toHaveTextContent("All providers (*)");
      await screen.getByTestId("team-preprompt-add-open").click();
      await expect
        .element(screen.getByTestId("team-preprompt-driver-select"))
        .toHaveTextContent("All providers (*)");
      await expect
        .element(screen.getByTestId("team-preprompt-scope-select"))
        .toHaveTextContent("Thread start (prefix-cached)");
    } finally {
      (teamStateA as { providers: ReadonlyArray<TeamProvider> }).providers = prevProvidersA;
    }
  });

  it("supports invite maxUses/expiresInHours, manual join button, Leave Team, and typed Delete Team confirmation", async () => {
    mockState.createInviteHandler
      .mockReset()
      .mockResolvedValueOnce(AsyncResult.success(makeInviteResult("t3team_multi")));
    mockState.confirmDialogHandler.mockReset().mockResolvedValue(true);
    mockState.leaveTeamHandler
      .mockReset()
      .mockResolvedValueOnce(
        AsyncResult.success({ left: true, memberId: teamStateC.currentMember!.id }),
      );
    mockState.deleteTeamHandler
      .mockReset()
      .mockResolvedValueOnce(AsyncResult.success({ deleted: true, teamId: teamStateA.team!.id }));
    mockState.removeLocalBindingHandler
      .mockReset()
      .mockResolvedValue(AsyncResult.success(undefined));
    mockState.removeEnvironmentHandler
      .mockReset()
      .mockResolvedValue(AsyncResult.success(undefined));

    await using screen = await render(<TeamsSettings />);

    // Manual join button opens TeamJoinDialog without needing a pasted invite URL.
    await expect.element(screen.getByTestId("team-join-manual-open")).toBeVisible();

    // WAI-ARIA tabpanel association & keyboard navigation (ArrowRight moves to Access & Environments).
    await expect.element(screen.getByRole("tabpanel")).toBeVisible();
    const overviewTab = screen.getByTestId("teams-tab-overview");
    await overviewTab.click();
    await expect.element(overviewTab).toHaveAttribute("aria-selected", "true");
    await expect.element(overviewTab).toHaveAttribute("tabindex", "0");
    await expect.element(screen.getByTestId("teams-tab-access")).toHaveAttribute("tabindex", "-1");

    // Invite form exposes maxUses and expiresInHours.
    await screen.getByTestId("team-invite-open-form").click();
    await screen.getByTestId("team-invite-max-uses-input").fill("5");
    await screen.getByTestId("team-invite-expiry-select").click();
    await screen.getByRole("option", { name: "24 hours" }).click();
    await screen.getByTestId("team-invite-create").click();
    expect(mockState.createInviteHandler).toHaveBeenCalledWith({
      environmentId: envA,
      input: expect.objectContaining({
        maxUses: 5,
        expiresInHours: 24,
      }),
    });

    // Server A: sole active owner cannot click Leave Team, but CAN open typed Delete Team dialog.
    await expect.element(screen.getByTestId("team-leave-button")).toBeDisabled();
    await screen.getByTestId("team-delete-open-button").click();
    await expect.element(screen.getByTestId("team-delete-confirm-dialog")).toBeVisible();
    await expect.element(screen.getByTestId("team-delete-confirm-submit")).toBeDisabled();
    await screen.getByTestId("team-delete-confirm-input").fill("Team Alpha");
    await expect.element(screen.getByTestId("team-delete-confirm-submit")).toBeEnabled();
    await screen.getByTestId("team-delete-confirm-submit").click();
    expect(mockState.deleteTeamHandler).toHaveBeenCalledWith({
      environmentId: envA,
      input: { confirmTeamName: "Team Alpha" },
    });

    // Server C: regular member CAN click Leave Team (uses confirm dialog, no Delete Team button).
    await screen.getByTestId("team-server-select").click();
    await screen.getByRole("option", { name: /Server C/ }).click();
    expect(screen.getByTestId("team-delete-open-button").query()).toBeNull();
    await expect.element(screen.getByTestId("team-leave-button")).toBeEnabled();
    await screen.getByTestId("team-leave-button").click();
    expect(mockState.confirmDialogHandler).toHaveBeenCalled();
    expect(mockState.leaveTeamHandler).toHaveBeenCalledWith({
      environmentId: envC,
      input: {},
    });
  });
});
