import { RegistryContext } from "@effect/atom-react";
import {
  ALL_TEAM_ROLES,
  EnvironmentId,
  TeamId,
  TeamMemberId,
  TeamViewId,
  ThreadId,
  type TeamPseudo,
  type TeamView,
} from "@t3tools/contracts";
import type { TeamEnvironmentState } from "@t3tools/client-runtime/team";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { SidebarProvider } from "~/components/ui/sidebar";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { setTeamSidebarFilterMode } from "~/state/team";
import { render } from "../../../test/render";
import { TeamColleaguesToggle } from "./TeamColleaguesToggle";

const envA = EnvironmentId.make("env-toggle-a");
const teamId = TeamId.make("team-toggle-a");
const memberId = TeamMemberId.make("member-toggle-a");
const defaultViewId = TeamViewId.make("view-toggle-a");
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
const member = {
  id: memberId,
  teamId,
  pseudo: "alice" as TeamPseudo,
  role: "owner" as const,
  status: "active" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const activeTeamState: TeamEnvironmentState = {
  team: {
    id: teamId,
    name: "Toggle Team",
    defaultViewId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  currentMember: member,
  members: [member],
  views: [defaultView],
  invites: [],
  threadAttributions: [],
  followedThreadIds: new Set([ThreadId.make("thread-followed-1")]),
  snoozedByThreadId: new Map(),
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

vi.mock(import("../../state/team"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useTeamStatesByEnvironment: () => new Map([[envA, activeTeamState]]),
  };
});

describe("TeamColleaguesToggle", () => {
  it("renders mutually exclusive 3-state labels and aria-pressed semantics", async () => {
    setTeamSidebarFilterMode("mine");
    using _reset = {
      [Symbol.dispose]() {
        setTeamSidebarFilterMode("mine");
      },
    };
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <SidebarProvider>
          <TeamColleaguesToggle />
        </SidebarProvider>
      </RegistryContext.Provider>,
    );

    const followedToggle = screen.getByTestId("team-followed-filter-toggle");
    const colleaguesToggle = screen.getByTestId("team-colleagues-toggle");

    // Default: "mine"
    await expect.element(followedToggle).toHaveAttribute("aria-pressed", "false");
    await expect
      .element(followedToggle)
      .toHaveAttribute("aria-label", "Show followed threads only");
    await expect.element(colleaguesToggle).toHaveAttribute("aria-pressed", "false");
    await expect.element(colleaguesToggle).toHaveAttribute("aria-label", "Show all team threads");

    // Toggle followed -> "followed" (label clearly explains clicking returns to my threads)
    await followedToggle.click();
    await expect.element(followedToggle).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(followedToggle)
      .toHaveAttribute("aria-label", "Show my threads only (currently: Followed)");
    await expect.element(colleaguesToggle).toHaveAttribute("aria-pressed", "false");

    // Toggle colleagues -> "all" (turns off followed)
    await colleaguesToggle.click();
    await expect.element(followedToggle).toHaveAttribute("aria-pressed", "false");
    await expect.element(colleaguesToggle).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(colleaguesToggle)
      .toHaveAttribute("aria-label", "Show my threads only (currently: All team)");

    // Toggle colleagues again -> back to "mine"
    await colleaguesToggle.click();
    await expect.element(colleaguesToggle).toHaveAttribute("aria-pressed", "false");
    await expect.element(followedToggle).toHaveAttribute("aria-pressed", "false");
  });
});
