import {
  EnvironmentId,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  TeamViewId,
  type TeamInviteCreatedResult,
  type TeamPseudo,
} from "@t3tools/contracts";
import type { TeamEnvironmentState } from "@t3tools/client-runtime/team";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { TeamsSettings } from "./TeamsSettings";

const envA = EnvironmentId.make("env-team-a");
const envB = EnvironmentId.make("env-team-b");
const urlA = "https://team-a.example.com";
const urlB = "https://team-b.example.com";

const makeTeamState = (id: string, name: string, pseudo: string): TeamEnvironmentState => {
  const teamId = TeamId.make(`team-${id}`);
  const memberId = TeamMemberId.make(`member-${id}`);
  const member = {
    id: memberId,
    teamId,
    pseudo: pseudo as TeamPseudo,
    role: "owner" as const,
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    team: {
      id: teamId,
      name,
      defaultViewId: TeamViewId.make(`view-${id}`),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    currentMember: member,
    members: [member],
    invites: [],
    threadAttributions: [],
    memberById: new Map([[memberId, member]]),
    attributionByThreadId: new Map(),
  };
};

const teamStateA = makeTeamState("a", "Team Alpha", "alice");
const teamStateB = makeTeamState("b", "Team Beta", "alice");

const mockState = vi.hoisted(() => ({
  createInviteHandler:
    vi.fn<
      (args: {
        readonly environmentId: EnvironmentId;
        readonly input: unknown;
      }) => Promise<AsyncResult.AsyncResult<TeamInviteCreatedResult, unknown>>
    >(),
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
    ],
  })) as never,
  usePrimaryEnvironmentId: (() => envA) as never,
  useEnvironmentHttpBaseUrl: ((environmentId: EnvironmentId | null) =>
    environmentId === envA ? urlA : environmentId === envB ? urlB : null) as never,
}));

vi.mock(import("../../state/team"), async (original) => ({
  ...(await original()),
  useShowColleaguesThreads: () => false,
  useTeamStatesByEnvironment: () =>
    new Map<EnvironmentId, TeamEnvironmentState>([
      [envA, teamStateA],
      [envB, teamStateB],
    ]),
  useTeamEnvironmentState: (environmentId: EnvironmentId | null) =>
    environmentId === envB ? teamStateB : teamStateA,
  teamEnvironment: {
    initialize: { permissionAtom: () => alwaysAllowedAtom },
    updateMyPseudo: { permissionAtom: () => alwaysAllowedAtom },
    createInvite: { permissionAtom: () => alwaysAllowedAtom },
    revokeInvite: { permissionAtom: () => alwaysAllowedAtom },
  } as never,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => {
    const mock = vi.fn(async (args: { environmentId: EnvironmentId; input: unknown }) => {
      if (command && typeof command === "object") {
        return mockState.createInviteHandler(args);
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
});
