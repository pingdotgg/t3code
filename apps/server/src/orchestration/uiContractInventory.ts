export interface UiEntityContract {
  entity: string;
  requiredFields: string[];
  consumedBy: string[];
}

// Explicit UI inventory used to keep server read models aligned
// with what the current frontend renders.
export const UI_ENTITY_CONTRACTS: UiEntityContract[] = [
  {
    entity: "Project",
    requiredFields: ["id", "name", "cwd", "model"],
    consumedBy: ["apps/web/src/components/Sidebar.tsx"],
  },
  {
    entity: "Thread",
    requiredFields: [
      "id",
      "projectId",
      "title",
      "model",
      "branch",
      "worktreePath",
      "createdAt",
      "latestTurnId",
      "latestTurnStartedAt",
      "latestTurnCompletedAt",
      "latestTurnDurationMs",
      "error",
    ],
    consumedBy: [
      "apps/web/src/components/Sidebar.tsx",
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/components/BranchToolbar.tsx",
    ],
  },
  {
    entity: "Message",
    requiredFields: ["id", "role", "text", "createdAt", "streaming"],
    consumedBy: ["apps/web/src/components/ChatView.tsx"],
  },
  {
    entity: "ProviderSession",
    requiredFields: [
      "sessionId",
      "provider",
      "status",
      "threadId",
      "activeTurnId",
      "createdAt",
      "updatedAt",
      "lastError",
    ],
    consumedBy: ["apps/web/src/components/ChatView.tsx", "apps/web/src/components/Sidebar.tsx"],
  },
  {
    entity: "TurnDiffSummary",
    requiredFields: ["turnId", "completedAt", "status", "files"],
    consumedBy: ["apps/web/src/components/DiffPanel.tsx", "apps/web/src/components/ChatView.tsx"],
  },
  {
    entity: "GitReadModel",
    requiredFields: ["projectId", "branch", "hasWorkingTreeChanges", "aheadCount", "behindCount"],
    consumedBy: ["apps/web/src/components/GitActionsControl.tsx", "apps/web/src/components/BranchToolbar.tsx"],
  },
];
