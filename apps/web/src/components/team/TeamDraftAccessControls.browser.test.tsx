import {
  EMPTY_TEAM_ENVIRONMENT_STATE,
  type TeamEnvironmentState,
} from "@t3tools/client-runtime/team";
import {
  EnvironmentId,
  TeamId,
  TeamMemberId,
  TeamViewId,
  type TeamMember,
  type TeamPseudo,
  type TeamView,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  clearTeamDraftAccessOptions,
  readTeamDraftAccessOptions,
  setTeamDraftViewId,
} from "~/state/team";
import { TeamDraftAccessControls } from "./TeamDraftAccessControls";

const mockState = vi.hoisted(() => ({
  teamStateByEnv: new Map<EnvironmentId, TeamEnvironmentState>(),
}));

vi.mock(import("~/state/team"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useTeamEnvironmentState: (envId: EnvironmentId | null) =>
      (envId !== null ? mockState.teamStateByEnv.get(envId) : undefined) ??
      EMPTY_TEAM_ENVIRONMENT_STATE,
  };
});

describe("TeamDraftAccessControls (P1-8)", () => {
  it("renders view selector and lock toggle for local drafts targeting a correlated team environment and updates draft access options", async () => {
    const teamEnvId = EnvironmentId.make("env-team-server");
    const localEnvId = EnvironmentId.make("env-local-laptop");
    const teamId = TeamId.make("team-draft-test");
    const defaultViewId = TeamViewId.make("view-default");
    const opsViewId = TeamViewId.make("view-ops");
    const aliceId = TeamMemberId.make("member-alice");
    const now = "2026-11-26T12:00:00.000Z";
    const draftKey = `${localEnvId}\0draft-local-team-1`;

    const alice: TeamMember = {
      id: aliceId,
      teamId,
      pseudo: "alice" as TeamPseudo,
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const defaultView: TeamView = {
      id: defaultViewId,
      teamId,
      name: "Default",
      description: null,
      isDefault: true,
      readRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
      postRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
      createdAt: now,
      updatedAt: now,
    };
    const opsView: TeamView = {
      id: opsViewId,
      teamId,
      name: "Ops",
      description: null,
      isDefault: false,
      readRule: { roles: ["owner", "admin"], memberIds: [] },
      postRule: { roles: ["owner", "admin"], memberIds: [] },
      createdAt: now,
      updatedAt: now,
    };
    const teamState: TeamEnvironmentState = {
      ...EMPTY_TEAM_ENVIRONMENT_STATE,
      team: {
        id: teamId,
        name: "Acme",
        displayName: "Acme",
        defaultViewId,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: alice,
      members: [alice],
      views: [defaultView, opsView],
      viewById: new Map([
        [defaultViewId, defaultView],
        [opsViewId, opsView],
      ]),
    };

    mockState.teamStateByEnv = new Map([[teamEnvId, teamState]]);
    using _cleanup = {
      [Symbol.dispose]() {
        mockState.teamStateByEnv = new Map();
        clearTeamDraftAccessOptions(draftKey);
      },
    };

    // Passing the local envId alone hides controls (no team on local env), while passing
    // activeProjectTeamAssignment.teamEnvironmentId exposes both View and Lock controls!
    await using hiddenScreen = await render(
      <TeamDraftAccessControls environmentId={localEnvId} draftKey={draftKey} />,
    );
    expect(hiddenScreen.getByTestId("team-draft-view-select").query()).toBeNull();
    expect(hiddenScreen.getByTestId("team-draft-lock-toggle").query()).toBeNull();

    setTeamDraftViewId(draftKey, opsViewId);
    await using visibleScreen = await render(
      <TeamDraftAccessControls environmentId={teamEnvId} draftKey={draftKey} />,
    );
    expect(visibleScreen.getByTestId("team-draft-view-select").query()).not.toBeNull();
    const lockToggle = visibleScreen.getByTestId("team-draft-lock-toggle");
    expect(lockToggle.element().getAttribute("aria-pressed")).toBe("false");

    await lockToggle.click();
    expect(readTeamDraftAccessOptions(draftKey)).toEqual({
      viewId: opsViewId,
      locked: true,
    });
  });
});
