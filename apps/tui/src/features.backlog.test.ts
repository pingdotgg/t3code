import { describe, expect, it } from "bun:test";

interface WebFeatureGap {
  /** Stable identifier used when a gap moves or is split into smaller scenarios. */
  readonly id: string;
  readonly area: string;
  /** Primary web implementation proving that this is a real, shipped capability. */
  readonly webSource: `apps/web/src/${string}`;
  readonly scenarios: ReadonlyArray<`Given ${string}, when ${string}, then ${string}.`>;
}

/**
 * User-facing capabilities shipped in the web UI that still need a TUI design.
 *
 * Each scenario is deliberately skipped until its feature ships. The active
 * catalog test below still fails when an id is duplicated, a scenario stops
 * following Given/When/Then, or its web implementation disappears. This keeps
 * the list useful as both an executable backlog and a guard against stale claims.
 */
const WEB_UI_GAPS = [
  {
    id: "composer-provider-traits",
    area: "Composer provider controls",
    webSource: "apps/web/src/components/chat/ChatComposer.tsx",
    scenarios: [
      "Given the selected provider exposes configurable traits, when the composer opens, then the TUI lets the user inspect and change those traits.",
      "Given the terminal is too narrow for every composer control, when the controls would overflow, then the TUI exposes them through a compact menu.",
    ],
  },
  {
    id: "composer-command-discovery",
    area: "Composer commands, skills, and mentions",
    webSource: "apps/web/src/components/chat/ComposerCommandMenu.tsx",
    scenarios: [
      "Given the user types a slash command, when matching built-in or provider commands exist, then the TUI offers a searchable command menu.",
      "Given the user references a skill or workspace file, when the mention trigger is typed, then the TUI offers matching items and inserts the selection.",
    ],
  },
  {
    id: "composer-clipboard-attachments",
    area: "Composer clipboard image attachments",
    webSource: "apps/web/src/components/chat/ChatComposer.tsx",
    scenarios: [
      "Given the clipboard contains an image, when the user pastes in the composer, then the TUI previews it and sends it as an attachment.",
    ],
  },
  {
    id: "composer-context-chips",
    area: "Structured composer context",
    webSource: "apps/web/src/components/chat/ComposerPendingElementContexts.tsx",
    scenarios: [
      "Given terminal output, preview annotations, or review comments were added as context, when the composer renders, then the TUI shows removable context chips before submission.",
    ],
  },
  {
    id: "plan-workspace",
    area: "Plan workspace",
    webSource: "apps/web/src/components/PlanSidebar.tsx",
    scenarios: [
      "Given a thread has an active plan, when plan progress changes, then the TUI shows the explanation and live status of every plan step.",
      "Given a proposed plan is visible, when the user opens plan actions, then the TUI can copy it or save it to the workspace as Markdown.",
    ],
  },
  {
    id: "project-scripts",
    area: "Project scripts",
    webSource: "apps/web/src/components/ProjectScriptsControl.tsx",
    scenarios: [
      "Given a project defines runnable scripts, when the user opens project actions, then the TUI can run the preferred script or select another one.",
      "Given the user manages project scripts, when a script is added or edited, then the TUI supports command, keybinding, worktree, and preview settings.",
    ],
  },
  {
    id: "branch-environment-switching",
    area: "Branch and environment switching",
    webSource: "apps/web/src/components/BranchToolbar.tsx",
    scenarios: [
      "Given a thread belongs to a logical project with multiple environments, when the active environment is changed, then the TUI switches to the matching project and thread context.",
      "Given the repository has another branch, when the user selects that branch, then the TUI creates or selects the appropriate thread workspace.",
    ],
  },
  {
    id: "pull-request-checkout",
    area: "Pull request checkout",
    webSource: "apps/web/src/components/PullRequestThreadDialog.tsx",
    scenarios: [
      "Given a pull request URL, checkout command, or number, when the user starts a review thread, then the TUI resolves it and prepares either a local checkout or dedicated worktree.",
    ],
  },
  {
    id: "publish-repository",
    area: "Repository publishing",
    webSource: "apps/web/src/components/GitActionsControl.tsx",
    scenarios: [
      "Given a repository has no remote, when the user chooses publish, then the TUI guides provider, repository, visibility, remote, and protocol selection in-app.",
    ],
  },
  {
    id: "diff-review-comments",
    area: "Diff review comments",
    webSource: "apps/web/src/components/diffs/AnnotatableCodeView.tsx",
    scenarios: [
      "Given a diff is open, when the user annotates a line or range, then the TUI stages that review comment as structured composer context.",
    ],
  },
  {
    id: "editable-settings",
    area: "Editable settings",
    webSource: "apps/web/src/components/settings/SettingsPanels.tsx",
    scenarios: [
      "Given the settings view is open, when the user changes provider instances, models, keybindings, or source-control credentials, then the TUI validates and persists those settings.",
    ],
  },
  {
    id: "project-lifecycle",
    area: "Project lifecycle",
    webSource: "apps/web/src/components/Sidebar.tsx",
    scenarios: [
      "Given the user needs another workspace, when project actions are opened, then the TUI can add, rename, regroup, or remove a project.",
    ],
  },
  {
    id: "message-actions",
    area: "Message and image actions",
    webSource: "apps/web/src/components/chat/MessagesTimeline.tsx",
    scenarios: [
      "Given a message is visible, when the user opens its actions, then the TUI can copy the message text to the terminal clipboard.",
    ],
  },
  {
    id: "preview-surface",
    area: "Terminal-adapted preview surface",
    webSource: "apps/web/src/components/RightPanelTabs.tsx",
    scenarios: [
      "Given a project exposes configured or discovered preview URLs, when the user opens previews, then the TUI lists them and provides an open or copy action without requiring an embedded browser.",
    ],
  },
] as const satisfies ReadonlyArray<WebFeatureGap>;

const REPOSITORY_ROOT = new URL("../../../", import.meta.url);

describe("Web UI capability backlog", () => {
  it("Given the parity catalog, when it is validated, then every gap is unique, source-backed, and written as BDD", async () => {
    const ids = WEB_UI_GAPS.map((gap) => gap.id);
    expect(new Set(ids).size).toBe(ids.length);

    const sourceChecks = await Promise.all(
      WEB_UI_GAPS.map(async (gap) => ({
        gap,
        exists: await Bun.file(new URL(gap.webSource, REPOSITORY_ROOT)).exists(),
      })),
    );
    for (const { gap, exists } of sourceChecks) {
      expect(exists, `${gap.id} web source`).toBe(true);
      expect(gap.scenarios.length, `${gap.id} scenarios`).toBeGreaterThan(0);
      for (const scenario of gap.scenarios) {
        expect(scenario, `${gap.id} scenario`).toMatch(/^Given .+, when .+, then .+\.$/);
      }
    }
  });

  for (const gap of WEB_UI_GAPS) {
    describe(gap.area, () => {
      for (const scenario of gap.scenarios) {
        it.skip(scenario, () => {});
      }
    });
  }
});
