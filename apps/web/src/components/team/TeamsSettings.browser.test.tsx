import {
  ALL_TEAM_ROLES,
  EnvironmentId,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  TeamViewId,
  type TeamInviteCreatedResult,
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
}));

const alwaysAllowedAtom = Atom.make(true);

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
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

    await screen.getByTestId("team-invite-create").click();

    await screen.getByTestId("team-server-select").click();
    await screen.getByRole("option", { name: /Server B/ }).click();

    resolveInvite(AsyncResult.success(makeInviteResult("t3team_server_a_inflight")));
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
});
