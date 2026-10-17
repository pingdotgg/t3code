/**
 * Web files the React Compiler must compile, relative to the repository root. Add a
 * file once it compiles cleanly. The root lint config makes the compiler's bailout
 * rules errors for these files, and src/reactCompiledFiles.test.ts compiles each one
 * to catch the bailouts lint cannot see.
 */
export const REACT_COMPILED_FILES = [
  "apps/web/src/components/PersistentThreadTerminals.tsx",
  "apps/web/src/components/Sidebar.tsx",
  "apps/web/src/components/chat/ChatComposer.tsx",
  "apps/web/src/components/chat/usePendingThreadRequests.ts",
  "apps/web/src/components/chat/composerFocusRedirect.ts",
  "apps/web/src/components/chat/useChatShortcuts.ts",
  "apps/web/src/components/chat/useProjectScriptEditing.ts",
  "apps/web/src/components/chat/useQueuedRunEdit.ts",
  "apps/web/src/components/chat/useUsageLimitsPanel.ts",
  "apps/web/src/components/chat/useWorktreeSetup.ts",
  "apps/web/src/components/preview/useAgentOpenedPreviews.ts",
  "apps/web/src/components/pullRequest/useThreadLinkedPullRequest.ts",
  "apps/web/src/components/terminal/**",
  "apps/web/src/hooks/useIncrementalTimelineEntries.ts",
  "apps/web/src/hooks/useProactivePanels.ts",
  "apps/web/src/hooks/useRightPanelSurfaceClose.ts",
] as const;

/**
 * Files the compiler already compiles that still carry manual memoization or
 * effect-driven state, so only the compile test covers them for now.
 */
export const REACT_COMPILED_FILES_PENDING_LINT = ["apps/web/src/components/ChatView.tsx"] as const;
