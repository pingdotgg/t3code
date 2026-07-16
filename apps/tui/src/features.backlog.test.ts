import { describe, expect, it } from "bun:test";

type BddScenario = `Given ${string}, when ${string}, then ${string}.`;
type ServerSource = `apps/server/src/${string}`;
type ClientSource =
  | { readonly client: "web"; readonly path: `apps/web/src/${string}` }
  | { readonly client: "mobile"; readonly path: `apps/mobile/src/${string}` };

interface ClientFeatureGap {
  /** Stable identifier used when a gap moves or is split into smaller scenarios. */
  readonly id: string;
  readonly area: string;
  /** Public server operations or streams that make the feature possible. */
  readonly serverCapabilities: ReadonlyArray<string>;
  /** Server implementations proving that the capability is shipped. */
  readonly serverSources: ReadonlyArray<ServerSource>;
  /** Web/mobile surfaces proving that the capability is user-facing. */
  readonly clientSources: ReadonlyArray<ClientSource>;
  readonly scenarios: ReadonlyArray<BddScenario>;
}

/**
 * User-facing server capabilities shipped in web or mobile that still need a
 * terminal-appropriate TUI design.
 *
 * Each scenario is deliberately skipped until its feature ships. The active
 * catalog test below still fails when evidence disappears, identifiers or
 * scenarios collide, or a scenario stops following Given/When/Then. Browser
 * automation internals and mobile-only OS services are intentionally excluded:
 * this is a product-parity backlog, not a literal inventory of every transport.
 */
const CLIENT_UI_GAPS = [
  {
    id: "environment-connections",
    area: "Environment connections and health",
    serverCapabilities: [
      "cloud.getRelayClientStatus",
      "cloud.installRelayClient",
      "subscribeServerLifecycle",
      "/api/connect/*",
    ],
    serverSources: ["apps/server/src/cloud/http.ts", "apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/settings/ConnectionsSettings.tsx" },
      {
        client: "mobile",
        path: "apps/mobile/src/features/connection/ConnectionsRouteScreen.tsx",
      },
    ],
    scenarios: [
      "Given local, remote, or cloud environments are known, when the user opens connections, then the TUI shows their availability and can activate a reachable environment.",
      "Given an environment disconnects or restarts, when its lifecycle state changes, then the TUI reports the interruption and recovers without losing the selected workflow.",
      "Given a cloud environment requires the relay client, when the user connects it, then the TUI can check availability and guide or run the supported installation flow.",
    ],
  },
  {
    id: "environment-access-management",
    area: "Environment pairing and access",
    serverCapabilities: ["subscribeAuthAccess", "/api/auth/pairing-links", "/api/auth/clients"],
    serverSources: ["apps/server/src/auth/http.ts", "apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/auth/PairingRouteSurface.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/connection/pairing.ts" },
    ],
    scenarios: [
      "Given the environment requires authorization, when the user supplies a pairing credential, then the TUI completes pairing and explains invalid or expired credentials.",
      "Given pairing links or client sessions exist, when access management is opened, then the TUI lists live access changes and can revoke one or all other clients.",
    ],
  },
  {
    id: "project-onboarding",
    area: "Project onboarding",
    serverCapabilities: [
      "filesystem.browse",
      "sourceControl.lookupRepository",
      "sourceControl.cloneRepository",
      "project.create",
    ],
    serverSources: ["apps/server/src/ws.ts", "apps/server/src/orchestration/decider.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/CommandPalette.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/projects/AddProjectScreen.tsx" },
    ],
    scenarios: [
      "Given the user wants to add a local workspace, when project onboarding opens, then the TUI can browse or create a directory and register it as a project.",
      "Given the user supplies a supported repository URL, when the remote is resolved, then the TUI previews its identity and clones it into the selected destination.",
      "Given a project path or repository is already registered, when the user confirms onboarding, then the TUI prevents a duplicate and selects the existing project.",
    ],
  },
  {
    id: "project-lifecycle",
    area: "Project lifecycle",
    serverCapabilities: ["project.meta.update", "project.delete"],
    serverSources: ["apps/server/src/orchestration/decider.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/Sidebar.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/threads/use-project-actions.ts" },
    ],
    scenarios: [
      "Given a project is registered, when project actions are opened, then the TUI can rename it or change its default model without altering its workspace identity.",
      "Given logical projects span multiple environments, when grouping is changed, then the TUI presents the same grouping and active member predictably.",
      "Given a project is no longer needed, when removal is confirmed, then the TUI unregisters it and preserves or deletes dependent data according to the server result.",
    ],
  },
  {
    id: "project-scripts",
    area: "Project scripts",
    serverCapabilities: ["project.meta.update", "terminal.open", "preview.open"],
    serverSources: ["apps/server/src/project/ProjectSetupScriptRunner.ts", "apps/server/src/ws.ts"],
    clientSources: [{ client: "web", path: "apps/web/src/components/ProjectScriptsControl.tsx" }],
    scenarios: [
      "Given a project defines runnable scripts, when the user opens project actions, then the TUI can run the preferred script or select another one.",
      "Given the user manages project scripts, when a script is added or edited, then the TUI supports its command, keybinding, worktree setup, and preview settings.",
      "Given a script reports progress or failure through its terminal, when it is running, then the TUI exposes the associated session and final outcome.",
    ],
  },
  {
    id: "workspace-file-actions",
    area: "Workspace file previews and editing",
    serverCapabilities: ["projects.writeFile", "assets.createUrl", "shell.openInEditor"],
    serverSources: ["apps/server/src/ws.ts", "apps/server/src/assets/AssetAccess.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/files/FilePreviewPanel.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx" },
    ],
    scenarios: [
      "Given a workspace contains an image or Markdown file, when the user opens it, then the TUI renders a terminal-appropriate preview instead of treating it as plain text.",
      "Given an editable text file is open, when the user changes and saves it, then the TUI writes the confirmed revision and reports conflicts or write failures.",
      "Given the server reports an available editor, when the user chooses open in editor, then the TUI launches the selected file through the server-supported editor action.",
    ],
  },
  {
    id: "composer-provider-state",
    area: "Composer provider availability and constraints",
    serverCapabilities: [
      "server.getConfig",
      "subscribeServerConfig",
      "thread.meta.update",
      "thread.turn.start",
    ],
    serverSources: ["apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/chat/ProviderStatusBanner.tsx" },
      { client: "mobile", path: "apps/mobile/src/lib/modelOptions.ts" },
    ],
    scenarios: [
      "Given a provider is disabled, unavailable, or unauthenticated, when models are listed, then the TUI explains the provider state and prevents an invalid selection.",
      "Given a provider requires a new thread for model changes, when the user chooses another model on an existing thread, then the TUI starts the supported new-thread flow instead of mutating the active session.",
      "Given provider configuration changes while the TUI is open, when the server publishes a config update, then model and provider controls refresh without restarting the TUI.",
    ],
  },
  {
    id: "composer-provider-traits",
    area: "Composer provider controls",
    serverCapabilities: ["server.getConfig", "thread.turn.start"],
    serverSources: ["apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/chat/ChatComposer.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/threads/ThreadComposer.tsx" },
    ],
    scenarios: [
      "Given the selected model exposes select or boolean option descriptors, when provider controls open, then the TUI lets the user inspect and change every supported trait without dropping existing selections.",
      "Given the terminal is too narrow for every composer control, when the controls would overflow, then the TUI exposes them through a compact menu.",
    ],
  },
  {
    id: "composer-command-discovery",
    area: "Composer commands, skills, and mentions",
    serverCapabilities: ["server.getConfig", "projects.searchEntries"],
    serverSources: ["apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/chat/ChatComposer.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/threads/ComposerCommandPopover.tsx" },
    ],
    scenarios: [
      "Given the user types a slash command, when matching built-in or provider commands exist, then the TUI offers a searchable command menu and inserts the selection.",
      "Given the user types a skill trigger, when enabled provider skills match, then the TUI searches their names and descriptions and inserts the selected skill.",
      "Given the user references a workspace file or directory, when the mention trigger is typed, then the TUI queries matching entries and inserts the selected path.",
    ],
  },
  {
    id: "composer-clipboard-attachments",
    area: "Composer clipboard image attachments",
    serverCapabilities: ["thread.turn.start"],
    serverSources: ["apps/server/src/orchestration/decider.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/chat/ChatComposer.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/threads/ThreadComposer.tsx" },
    ],
    scenarios: [
      "Given the clipboard contains a supported image, when the user pastes in the composer, then the TUI previews it and sends it as a bounded attachment.",
      "Given pasted images exceed attachment count or size limits, when they are staged, then the TUI rejects the excess safely and preserves valid draft content.",
    ],
  },
  {
    id: "composer-context-chips",
    area: "Structured composer context",
    serverCapabilities: ["thread.turn.start"],
    serverSources: ["apps/server/src/orchestration/decider.ts"],
    clientSources: [
      {
        client: "web",
        path: "apps/web/src/components/chat/ComposerPendingElementContexts.tsx",
      },
      {
        client: "mobile",
        path: "apps/mobile/src/features/review/ReviewCommentComposerSheet.tsx",
      },
    ],
    scenarios: [
      "Given terminal output, preview annotations, or review comments were added as context, when the composer renders, then the TUI shows removable context chips before submission.",
      "Given structured context is submitted, when the resulting user message renders, then the TUI preserves a recognizable inline representation of that context.",
    ],
  },
  {
    id: "plan-workspace",
    area: "Plan workspace",
    serverCapabilities: ["thread.proposed-plan.upsert", "projects.writeFile"],
    serverSources: ["apps/server/src/orchestration/decider.ts", "apps/server/src/ws.ts"],
    clientSources: [{ client: "web", path: "apps/web/src/components/PlanSidebar.tsx" }],
    scenarios: [
      "Given a thread has an active plan, when plan progress changes, then the TUI shows the explanation and live status of every plan step.",
      "Given a proposed plan is visible, when the user opens plan actions, then the TUI can copy it or save it to the workspace as Markdown.",
      "Given a plan has already been implemented, when its card renders, then the TUI identifies the implementation thread and does not offer a duplicate implementation action.",
    ],
  },
  {
    id: "archived-threads",
    area: "Archived threads",
    serverCapabilities: [
      "orchestration.getArchivedShellSnapshot",
      "thread.unarchive",
      "thread.delete",
    ],
    serverSources: ["apps/server/src/ws.ts", "apps/server/src/orchestration/decider.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/settings/SettingsPanels.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx" },
    ],
    scenarios: [
      "Given threads have been archived, when the archive view opens, then the TUI loads them across projects and supports search and deterministic sorting.",
      "Given an archived thread is selected, when the user chooses unarchive or delete, then the TUI performs the action and refreshes the archived snapshot.",
    ],
  },
  {
    id: "branch-worktree-management",
    area: "Branch, worktree, and environment switching",
    serverCapabilities: [
      "vcs.createRef",
      "vcs.switchRef",
      "vcs.createWorktree",
      "vcs.removeWorktree",
      "thread.meta.update",
    ],
    serverSources: ["apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/BranchToolbar.tsx" },
      {
        client: "mobile",
        path: "apps/mobile/src/features/threads/git/GitBranchesSheet.tsx",
      },
    ],
    scenarios: [
      "Given an existing thread can move to another branch, when the user selects or creates a ref, then the TUI safely switches the repository and updates thread metadata.",
      "Given a branch needs an isolated workspace, when the user creates or removes its worktree, then the TUI preserves the selected base and reports provisioning or cleanup failures.",
      "Given a logical project has matching members in multiple environments, when the active environment changes, then the TUI selects the matching project and thread context.",
    ],
  },
  {
    id: "pull-request-checkout",
    area: "Pull request checkout",
    serverCapabilities: ["git.resolvePullRequest", "git.preparePullRequestThread"],
    serverSources: ["apps/server/src/git/GitWorkflowService.ts", "apps/server/src/ws.ts"],
    clientSources: [{ client: "web", path: "apps/web/src/components/PullRequestThreadDialog.tsx" }],
    scenarios: [
      "Given a pull request URL, checkout command, or number, when the user starts a review thread, then the TUI resolves it and previews its repository and refs.",
      "Given a pull request has been resolved, when checkout is confirmed, then the TUI prepares either the local checkout or a dedicated worktree and opens the resulting thread.",
    ],
  },
  {
    id: "repository-setup-publishing",
    area: "Repository setup and publishing",
    serverCapabilities: [
      "server.discoverSourceControl",
      "vcs.init",
      "sourceControl.publishRepository",
    ],
    serverSources: [
      "apps/server/src/sourceControl/SourceControlDiscovery.ts",
      "apps/server/src/ws.ts",
    ],
    clientSources: [
      { client: "web", path: "apps/web/src/components/GitActionsControl.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/projects/AddProjectScreen.tsx" },
    ],
    scenarios: [
      "Given a workspace is not a repository, when source-control actions open, then the TUI can initialize it and refresh its status.",
      "Given source-control providers are discovered, when their status is shown, then the TUI identifies authenticated, unavailable, and actionable setup states.",
      "Given a repository has no remote, when the user chooses publish, then the TUI guides provider, repository, visibility, remote, and protocol selection in-app.",
    ],
  },
  {
    id: "git-operation-progress",
    area: "Source-control operation progress",
    serverCapabilities: ["git.runStackedAction"],
    serverSources: ["apps/server/src/git/GitManager.ts", "apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/GitActionsControl.tsx" },
      {
        client: "mobile",
        path: "apps/mobile/src/features/threads/GitActionProgressOverlay.tsx",
      },
    ],
    scenarios: [
      "Given a stacked git action is running, when the server streams phases, hooks, and output, then the TUI shows the current operation instead of only a generic busy state.",
      "Given a git phase or hook fails, when the action completes, then the TUI retains the actionable error and refreshes repository status.",
    ],
  },
  {
    id: "review-workspace",
    area: "Branch diff review and comments",
    serverCapabilities: ["review.getDiffPreview", "orchestration.getFullThreadDiff"],
    serverSources: ["apps/server/src/review/ReviewService.ts", "apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/DiffPanel.tsx" },
      { client: "mobile", path: "apps/mobile/src/features/review/ReviewSheet.tsx" },
    ],
    scenarios: [
      "Given a repository has changes relative to a base ref, when review opens, then the TUI can select the comparison and toggle whitespace handling without replacing checkpoint review.",
      "Given a large diff spans files and sections, when the user navigates it, then the TUI preserves file visibility and the selected review location.",
      "Given a diff is open, when the user annotates a line or range, then the TUI stages that review comment as structured composer context.",
    ],
  },
  {
    id: "terminal-session-actions",
    area: "Terminal session actions and context",
    serverCapabilities: ["terminal.clear", "terminal.restart", "terminal.write"],
    serverSources: ["apps/server/src/terminal/Manager.ts", "apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/ThreadTerminalDrawer.tsx" },
      {
        client: "mobile",
        path: "apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx",
      },
    ],
    scenarios: [
      "Given terminal output is selected, when the user adds it to the composer, then the TUI stages a bounded terminal-context chip with its session identity.",
    ],
  },
  {
    id: "preview-surface",
    area: "Terminal-adapted preview surface",
    serverCapabilities: [
      "preview.list",
      "preview.open",
      "preview.refresh",
      "preview.close",
      "subscribeDiscoveredLocalServers",
    ],
    serverSources: ["apps/server/src/preview/Manager.ts", "apps/server/src/ws.ts"],
    clientSources: [{ client: "web", path: "apps/web/src/components/RightPanelTabs.tsx" }],
    scenarios: [
      "Given a project exposes configured or discovered preview URLs, when the user opens previews, then the TUI lists them and provides open or copy actions without requiring an embedded browser.",
      "Given preview sessions already exist, when the user refreshes or closes one, then the TUI updates the server session list and reports unreachable targets.",
      "Given a project script has a configured preview URL, when it starts with auto-open enabled, then the TUI surfaces that URL through the preview list.",
    ],
  },
  {
    id: "content-actions",
    area: "Message, link, and editor actions",
    serverCapabilities: ["orchestration.subscribeThread", "shell.openInEditor"],
    serverSources: ["apps/server/src/ws.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/chat/MessagesTimeline.tsx" },
      { client: "web", path: "apps/web/src/components/chat/OpenInPicker.tsx" },
      { client: "mobile", path: "apps/mobile/src/components/CopyTextButton.tsx" },
    ],
    scenarios: [
      "Given a message, proposed plan, or diff is visible, when the user chooses copy, then the TUI writes the complete text to the terminal clipboard and confirms the action.",
      "Given a message or source-control status contains an external URL, when the user activates it, then the TUI opens it with a supported launcher or offers a copy fallback.",
      "Given a file location is referenced in a message or diff, when open in editor is selected, then the TUI sends the path and location to the server-supported editor action.",
    ],
  },
  {
    id: "editable-settings",
    area: "Editable server settings",
    serverCapabilities: [
      "server.updateSettings",
      "server.upsertKeybinding",
      "server.removeKeybinding",
      "subscribeServerConfig",
    ],
    serverSources: ["apps/server/src/serverSettings.ts", "apps/server/src/keybindings.ts"],
    clientSources: [
      { client: "web", path: "apps/web/src/components/settings/ProviderInstanceCard.tsx" },
      { client: "web", path: "apps/web/src/components/settings/KeybindingsSettings.tsx" },
    ],
    scenarios: [
      "Given server settings are open, when the user changes thread defaults, git behavior, or text-generation defaults, then the TUI validates and persists the patch.",
      "Given provider instances need configuration, when the user adds or edits one, then the TUI supports driver settings and secrets without discarding unknown instance data.",
      "Given custom keybindings are configured, when the user adds, replaces, or removes one, then the TUI validates conflicts and reflects the live server configuration.",
    ],
  },
  {
    id: "server-operations",
    area: "Provider maintenance and server diagnostics",
    serverCapabilities: [
      "server.refreshProviders",
      "server.updateProvider",
      "server.getTraceDiagnostics",
      "server.getProcessDiagnostics",
      "server.getProcessResourceHistory",
      "server.signalProcess",
    ],
    serverSources: [
      "apps/server/src/provider/providerMaintenance.ts",
      "apps/server/src/diagnostics/ProcessDiagnostics.ts",
      "apps/server/src/ws.ts",
    ],
    clientSources: [
      { client: "web", path: "apps/web/src/components/settings/DiagnosticsSettings.tsx" },
      { client: "web", path: "apps/web/src/components/settings/SettingsPanels.tsx" },
    ],
    scenarios: [
      "Given provider state may be stale, when the user refreshes it, then the TUI shows current installation, authentication, version, and availability results.",
      "Given a provider update is available, when the user runs it, then the TUI streams queued, running, success, unchanged, or failure state and refreshes provider configuration.",
      "Given diagnostics are requested, when trace or process data arrives, then the TUI presents bounded summaries and resource history without blocking conversation work.",
      "Given a descendant process is unhealthy, when the user confirms a supported signal, then the TUI targets only the validated process and reports the server result.",
    ],
  },
] as const satisfies ReadonlyArray<ClientFeatureGap>;

const REPOSITORY_ROOT = new URL("../../../", import.meta.url);

describe("Server-backed client capability backlog", () => {
  it("Given the parity catalog, when it is validated, then every gap is unique, source-backed, and written as BDD", async () => {
    const ids = CLIENT_UI_GAPS.map((gap) => gap.id);
    expect(new Set(ids).size).toBe(ids.length);

    const scenarios = CLIENT_UI_GAPS.flatMap((gap) => gap.scenarios);
    expect(new Set(scenarios).size).toBe(scenarios.length);

    const sourceChecks = await Promise.all(
      CLIENT_UI_GAPS.flatMap((gap) => [
        ...gap.serverSources.map(async (path) => ({
          gap,
          kind: "server" as const,
          path,
          exists: await Bun.file(new URL(path, REPOSITORY_ROOT)).exists(),
        })),
        ...gap.clientSources.map(async (source) => ({
          gap,
          kind: source.client,
          path: source.path,
          exists: await Bun.file(new URL(source.path, REPOSITORY_ROOT)).exists(),
        })),
      ]),
    );

    for (const gap of CLIENT_UI_GAPS) {
      expect(gap.serverCapabilities.length, `${gap.id} server capabilities`).toBeGreaterThan(0);
      expect(gap.serverSources.length, `${gap.id} server sources`).toBeGreaterThan(0);
      expect(gap.clientSources.length, `${gap.id} client sources`).toBeGreaterThan(0);
      expect(gap.scenarios.length, `${gap.id} scenarios`).toBeGreaterThan(0);

      expect(new Set(gap.serverCapabilities).size, `${gap.id} duplicate server capabilities`).toBe(
        gap.serverCapabilities.length,
      );
      for (const capability of gap.serverCapabilities) {
        expect(capability.trim(), `${gap.id} server capability`).toBe(capability);
        expect(capability.length, `${gap.id} server capability`).toBeGreaterThan(0);
      }

      const evidencePaths = [...gap.serverSources, ...gap.clientSources.map(({ path }) => path)];
      expect(new Set(evidencePaths).size, `${gap.id} duplicate evidence paths`).toBe(
        evidencePaths.length,
      );
      for (const source of gap.clientSources) {
        expect(
          source.path.startsWith(`apps/${source.client}/src/`),
          `${gap.id} client source`,
        ).toBe(true);
      }
      for (const scenario of gap.scenarios) {
        expect(scenario, `${gap.id} scenario`).toMatch(/^Given .+, when .+, then .+\.$/);
      }
    }

    for (const { gap, kind, path, exists } of sourceChecks) {
      expect(exists, `${gap.id} ${kind} source: ${path}`).toBe(true);
    }
  });

  for (const gap of CLIENT_UI_GAPS) {
    describe(gap.area, () => {
      for (const scenario of gap.scenarios) {
        it.skip(scenario, () => {});
      }
    });
  }
});
