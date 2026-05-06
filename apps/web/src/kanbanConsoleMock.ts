import type {
  KanbanColumnId,
  KanbanConsoleAgentWorkflow,
  KanbanConsoleArtifact,
  KanbanConsoleCommandRun,
  KanbanConsoleGitOpsPolicy,
  KanbanConsoleGitStatusSnapshot,
  KanbanConsoleLocale,
  KanbanConsoleManagedRepo,
  KanbanConsolePrWatchHealth,
  KanbanConsoleProjectBoard,
  KanbanConsolePullRequestWatch,
  KanbanConsoleReleaseReadiness,
  KanbanConsoleSnapshot,
  KanbanConsoleSuggestedFix,
  KanbanConsoleTask,
  KanbanConsoleTaskTransitionRequest,
  KanbanConsoleTaskTransitionResult,
} from "@t3tools/contracts";

export type {
  KanbanColumnId,
  KanbanConsoleLocale,
  KanbanConsolePrWatchHealth,
  KanbanConsolePullRequestWatch,
  KanbanConsoleSnapshot,
  KanbanConsoleSuggestedFix,
  KanbanConsoleTaskTransitionRequest,
  KanbanConsoleTaskTransitionResult,
};

export type ConsoleStateId = "empty" | "loading" | "permission" | "missing-auth" | "error";

export type ConsoleViewId =
  | "board"
  | "git"
  | "artifacts"
  | "prs"
  | "timeline"
  | "cli"
  | "gitops"
  | "settings"
  | "states";

export type KanbanTaskMock = KanbanConsoleTask;
export type MonorepoMock = KanbanConsoleManagedRepo;

export const kanbanColumns: Array<{
  id: KanbanColumnId;
  labelKey: keyof typeof kanbanConsoleMessages.en;
}> = [
  { id: "backlog", labelKey: "columnBacklog" },
  { id: "ready", labelKey: "columnReady" },
  { id: "in-progress", labelKey: "columnProgress" },
  { id: "review", labelKey: "columnReview" },
  { id: "blocked", labelKey: "columnBlocked" },
  { id: "done", labelKey: "columnDone" },
];

export const consoleViews: Array<{
  id: ConsoleViewId;
  labelKey: keyof typeof kanbanConsoleMessages.en;
}> = [
  { id: "board", labelKey: "viewBoard" },
  { id: "git", labelKey: "viewGit" },
  { id: "artifacts", labelKey: "viewArtifacts" },
  { id: "prs", labelKey: "viewPrs" },
  { id: "timeline", labelKey: "viewTimeline" },
  { id: "cli", labelKey: "viewCli" },
  { id: "gitops", labelKey: "viewGitops" },
  { id: "settings", labelKey: "viewSettings" },
  { id: "states", labelKey: "viewStates" },
];

export const consoleStateIds: ConsoleStateId[] = [
  "empty",
  "loading",
  "permission",
  "missing-auth",
  "error",
];

export const kanbanConsoleMessages = {
  en: {
    actionQueueCommand: "Queue mock command",
    actionMove: "Move",
    actionOpenSheet: "Open move sheet",
    actionPreview: "Preview",
    actionSaveDraft: "Save draft",
    actionSimulate: "Simulate",
    actionWatch: "Watch",
    agentActions: "Agent actions",
    artifactsHeading: "Product artifacts",
    boardHeading: "GitHub Projects board",
    checks: "Checks",
    cliHeading: "CLI command console",
    columnBacklog: "Backlog",
    columnBlocked: "Blocked",
    columnDone: "Done",
    columnProgress: "In progress",
    columnReady: "Ready",
    columnReview: "In review",
    comments: "Comments",
    consoleTitle: "Kanban Project Console",
    detailHeading: "Task detail",
    emptyState: "No tasks match this workspace filter.",
    errorState: "Project sync failed. Retry uses mock data only.",
    gitHeading: "Lazygit-style git status",
    gitopsHeading: "GitOps and release dashboard",
    issueFields: "Issue and project fields",
    loadingState: "Loading project snapshots.",
    missingAuthState: "Connect GitHub before live sync.",
    moveSheetTitle: "Move card",
    permissionState: "Project write permission required.",
    prsHeading: "PR watcher",
    settingsHeading: "Console settings",
    sidebarHeading: "Registered monorepos",
    statesHeading: "State previews",
    timelineHeading: "Issue and PR timeline",
    viewArtifacts: "Artifacts",
    viewBoard: "Board",
    viewCli: "CLI",
    viewGit: "Git",
    viewGitops: "GitOps",
    viewPrs: "PRs",
    viewSettings: "Settings",
    viewStates: "States",
    viewTimeline: "Timeline",
  },
  ar: {
    actionQueueCommand: "إضافة أمر تجريبي",
    actionMove: "نقل",
    actionOpenSheet: "فتح لوحة النقل",
    actionPreview: "معاينة",
    actionSaveDraft: "حفظ مسودة",
    actionSimulate: "محاكاة",
    actionWatch: "مراقبة",
    agentActions: "إجراءات الوكيل",
    artifactsHeading: "مستندات المنتج",
    boardHeading: "لوحة مشاريع GitHub",
    checks: "الفحوصات",
    cliHeading: "وحدة أوامر CLI",
    columnBacklog: "المهام المؤجلة",
    columnBlocked: "محظور",
    columnDone: "منجز",
    columnProgress: "قيد التنفيذ",
    columnReady: "جاهز",
    columnReview: "قيد المراجعة",
    comments: "التعليقات",
    consoleTitle: "وحدة تحكم مشروع كانبان",
    detailHeading: "تفاصيل المهمة",
    emptyState: "لا توجد مهام تطابق فلتر مساحة العمل.",
    errorState: "فشلت مزامنة المشروع. إعادة المحاولة تستخدم بيانات تجريبية فقط.",
    gitHeading: "حالة Git بنمط Lazygit",
    gitopsHeading: "لوحة GitOps والإصدارات",
    issueFields: "حقول المشكلة والمشروع",
    loadingState: "جار تحميل لقطات المشروع.",
    missingAuthState: "اربط GitHub قبل المزامنة الحية.",
    moveSheetTitle: "نقل البطاقة",
    permissionState: "صلاحية الكتابة على المشروع مطلوبة.",
    prsHeading: "مراقب طلبات السحب",
    settingsHeading: "إعدادات وحدة التحكم",
    sidebarHeading: "مستودعات Monorepo المسجلة",
    statesHeading: "معاينات الحالات",
    timelineHeading: "خط زمني للمشاكل وطلبات السحب",
    viewArtifacts: "المستندات",
    viewBoard: "اللوحة",
    viewCli: "CLI",
    viewGit: "Git",
    viewGitops: "GitOps",
    viewPrs: "طلبات السحب",
    viewSettings: "الإعدادات",
    viewStates: "الحالات",
    viewTimeline: "الخط الزمني",
  },
} as const;

const managedRepos: MonorepoMock[] = [
  {
    id: "repo-kanban-console",
    name: "kanban-console",
    owner: "MohAnghabo",
    path: "/Users/mohanghabo/Projects/kanban-console",
    branch: "feature/t3-kanban-phase-3-contracts",
    ahead: 1,
    behind: 0,
    openPrs: 1,
    activeTasks: 7,
    status: "healthy",
  },
  {
    id: "repo-ai-starter-pro",
    name: "ai-starter-pro",
    owner: "MohAnghabo",
    path: "/Users/mohanghabo/Projects/ai-starter-pro",
    branch: "main",
    ahead: 0,
    behind: 0,
    openPrs: 0,
    activeTasks: 3,
    status: "attention",
  },
  {
    id: "repo-docs-product",
    name: "docs-product",
    owner: "MohAnghabo",
    path: "/Users/mohanghabo/Projects/docs-product",
    branch: "release/product-artifacts",
    ahead: 2,
    behind: 1,
    openPrs: 2,
    activeTasks: 4,
    status: "blocked",
  },
];

const projectBoards: KanbanConsoleProjectBoard[] = [
  {
    id: "board-kanban-console",
    owner: "MohAnghabo",
    title: "Kanban Project Console",
    source: "github-projects",
    columns: kanbanColumns.map((column) => column.id),
  },
];

const tasks: KanbanTaskMock[] = [
  {
    id: "t3-p2-1",
    issue: "ai-starter-pro#43",
    title: "Mock GitHub Projects board and card workflow",
    titleAr: "لوحة مشاريع GitHub التجريبية وسير عمل البطاقات",
    repo: "kanban-console",
    column: "in-progress",
    priority: "P1",
    assignee: "Codex",
    pr: "kanban-console#2",
    checks: { passing: 5, pending: 2, failing: 0 },
    agent: "Codex",
    updated: "Today 14:20",
    comments: 6,
  },
  {
    id: "t3-p2-2",
    issue: "ai-starter-pro#43",
    title: "Artifact browser for docs/product",
    titleAr: "متصفح مستندات docs/product",
    repo: "kanban-console",
    column: "ready",
    priority: "P2",
    assignee: "Claude",
    checks: { passing: 3, pending: 0, failing: 0 },
    agent: "Claude",
    updated: "Today 13:05",
    comments: 2,
  },
  {
    id: "t3-p2-3",
    issue: "kanban-console#pending",
    title: "PR watcher comments and check summaries",
    titleAr: "مراقبة تعليقات طلبات السحب وملخصات الفحوصات",
    repo: "kanban-console",
    column: "review",
    priority: "P1",
    assignee: "Human",
    pr: "kanban-console#1",
    checks: { passing: 12, pending: 0, failing: 1 },
    agent: "Human",
    updated: "Yesterday 18:44",
    comments: 11,
  },
  {
    id: "t3-p2-4",
    issue: "ai-starter-pro#43",
    title: "Settings for repos, bots, rules, and polling",
    titleAr: "إعدادات المستودعات والروبوتات والقواعد والاستطلاع",
    repo: "ai-starter-pro",
    column: "backlog",
    priority: "P2",
    assignee: "Codex",
    checks: { passing: 0, pending: 0, failing: 0 },
    agent: "Codex",
    updated: "May 5",
    comments: 1,
  },
  {
    id: "t3-p2-5",
    issue: "kanban-console#mock",
    title: "GitOps release health dashboard",
    titleAr: "لوحة صحة إصدارات GitOps",
    repo: "docs-product",
    column: "blocked",
    priority: "P0",
    assignee: "Human",
    checks: { passing: 4, pending: 1, failing: 2 },
    agent: "Human",
    updated: "May 4",
    comments: 9,
  },
  {
    id: "t3-p2-6",
    issue: "kanban-console#mock",
    title: "CLI command console with dry-run queue",
    titleAr: "وحدة أوامر CLI مع طابور تنفيذ تجريبي",
    repo: "kanban-console",
    column: "done",
    priority: "P1",
    assignee: "Claude",
    checks: { passing: 8, pending: 0, failing: 0 },
    agent: "Claude",
    updated: "May 3",
    comments: 4,
  },
];

const prWatches: KanbanConsolePullRequestWatch[] = [
  {
    id: "watch-pr-2",
    repo: "kanban-console",
    pr: "kanban-console#2",
    title: "Add phase 2 mock Kanban console",
    taskId: "t3-p2-1",
    checks: [
      { id: "check-validate", name: "Validate", status: "passing" },
      { id: "check-release-smoke", name: "Release Smoke", status: "pending" },
    ],
    reviewSignals: [
      {
        id: "signal-rtl",
        kind: "approval",
        source: "maintainer",
        summary: "Browser mock was approved after RTL smoke.",
        fingerprint: "approval:phase-2:rtl",
        createdAt: "2026-05-06T12:50:00.000Z",
      },
    ],
    lastSeenAt: "2026-05-06T13:00:00.000Z",
  },
  {
    id: "watch-pr-1",
    repo: "kanban-console",
    pr: "kanban-console#1",
    title: "Adopt governance baseline",
    taskId: "t3-p2-3",
    checks: [
      { id: "check-validate-1", name: "Validate", status: "failing" },
      { id: "check-smoke-1", name: "Release Smoke", status: "passing" },
    ],
    reviewSignals: [
      {
        id: "signal-ci",
        kind: "ci-failure",
        source: "GitHub Actions",
        summary: "Required check failed in a synthetic fixture.",
        fingerprint: "ci:validate:failure",
        createdAt: "2026-05-06T11:35:00.000Z",
      },
    ],
    lastSeenAt: "2026-05-06T11:40:00.000Z",
  },
];

const suggestedFixes: KanbanConsoleSuggestedFix[] = [
  {
    id: "fix-pr-1-validate",
    taskId: "t3-p2-3",
    prWatchId: "watch-pr-1",
    title: "Inspect failing Validate check",
    command: "/ship t3-kanban-project-console",
    status: "eligible",
    guardrails: ["requires-confirmation", "redact-logs", "no-project-write"],
  },
  {
    id: "fix-release-policy",
    taskId: "t3-p2-5",
    prWatchId: "watch-pr-2",
    title: "Release branch policy needs maintainer confirmation",
    command: "/orchestrate t3-kanban-project-console",
    status: "blocked",
    guardrails: ["protected-branch", "requires-human"],
  },
];

const commandRuns: KanbanConsoleCommandRun[] = [
  {
    id: "command-phase-3",
    label: "Phase 3 contracts",
    command: "/phase t3-kanban-project-console phase-3",
    status: "queued",
  },
  {
    id: "command-ship",
    label: "Ship readiness",
    command: "/ship t3-kanban-project-console",
    status: "blocked",
  },
];

const gitStatuses: KanbanConsoleGitStatusSnapshot[] = [
  {
    repoId: "repo-kanban-console",
    branch: "feature/t3-kanban-phase-3-contracts",
    upstream: "origin/feature/t3-kanban-phase-3-contracts",
    ahead: 1,
    behind: 0,
    files: [
      {
        path: "apps/web/src/components/KanbanConsoleMock.tsx",
        status: "unstaged",
        additions: 42,
        deletions: 3,
      },
      {
        path: "packages/contracts/src/kanbanConsole.ts",
        status: "untracked",
        additions: 250,
        deletions: 0,
      },
    ],
  },
];

const artifacts: KanbanConsoleArtifact[] = [
  {
    id: "artifact-plan",
    repoId: "repo-kanban-console",
    path: "docs/tasks/t3-kanban-project-console.md",
    title: "Kanban console task plan",
    status: "dirty",
    updatedAt: "2026-05-06T13:20:00.000Z",
  },
  {
    id: "artifact-product",
    repoId: "repo-kanban-console",
    path: "docs/product/project-console.md",
    title: "Project console product notes",
    status: "clean",
    updatedAt: "2026-05-06T10:00:00.000Z",
  },
];

const gitOpsPolicy: KanbanConsoleGitOpsPolicy = {
  protectedBranches: ["main", "release/*"],
  allowedWorkBranchPrefixes: [
    "feature/",
    "fix/",
    "chore/",
    "docs/",
    "ops/",
    "refactor/",
    "test/",
    "perf/",
  ],
  destructiveActionsRequireSecondConfirmation: true,
};

const releaseReadiness: KanbanConsoleReleaseReadiness = {
  branch: "release/product-artifacts",
  gates: [
    { id: "gate-validate", label: "Validate", status: "passing" },
    { id: "gate-smoke", label: "Release smoke", status: "pending" },
    { id: "gate-policy", label: "Protected branch policy", status: "blocked" },
  ],
};

const agentWorkflows: KanbanConsoleAgentWorkflow[] = [
  {
    id: "workflow-phase",
    label: "Implement phase",
    agent: "Codex",
    command: "/phase t3-kanban-project-console phase-3",
    available: true,
  },
  {
    id: "workflow-ship",
    label: "Ship readiness",
    agent: "Claude",
    command: "/ship t3-kanban-project-console",
    available: true,
  },
];

export const kanbanConsoleMockSnapshot: KanbanConsoleSnapshot = {
  version: 1,
  generatedAt: "2026-05-06T13:30:00.000Z",
  locale: "en",
  repos: managedRepos,
  boards: projectBoards,
  tasks,
  prWatches,
  suggestedFixes,
  commandRuns,
  gitStatuses,
  artifacts,
  gitOpsPolicy,
  releaseReadiness,
  agentWorkflows,
};

export interface KanbanConsoleProvider {
  readSnapshot(): KanbanConsoleSnapshot;
  previewTaskTransition(
    request: KanbanConsoleTaskTransitionRequest,
  ): KanbanConsoleTaskTransitionResult;
  listPrWatches(): readonly KanbanConsolePullRequestWatch[];
  listSuggestedFixes(): readonly KanbanConsoleSuggestedFix[];
  getPrWatchHealth(watch: KanbanConsolePullRequestWatch): KanbanConsolePrWatchHealth;
  isSuggestedFixEligible(fix: KanbanConsoleSuggestedFix): boolean;
}

export const kanbanConsoleMockProvider: KanbanConsoleProvider = {
  readSnapshot() {
    return kanbanConsoleMockSnapshot;
  },
  previewTaskTransition(request) {
    return previewTaskTransition(request);
  },
  listPrWatches() {
    return kanbanConsoleMockSnapshot.prWatches;
  },
  listSuggestedFixes() {
    return kanbanConsoleMockSnapshot.suggestedFixes;
  },
  getPrWatchHealth(watch) {
    return getPrWatchHealth(watch);
  },
  isSuggestedFixEligible(fix) {
    return isSuggestedFixEligible(fix);
  },
};

export const monorepos = kanbanConsoleMockProvider.readSnapshot().repos;
export const kanbanTasks = kanbanConsoleMockProvider.readSnapshot().tasks;

export function getLocaleDirection(locale: KanbanConsoleLocale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

export function getMessages(locale: KanbanConsoleLocale) {
  return kanbanConsoleMessages[locale];
}

export function getTasksByColumn(tasks: readonly KanbanTaskMock[] = kanbanTasks) {
  return kanbanColumns.map((column) => ({
    id: column.id,
    labelKey: column.labelKey,
    tasks: tasks.filter((task) => task.column === column.id),
  }));
}

export function moveTaskToColumn(
  tasks: readonly KanbanTaskMock[],
  taskId: string,
  nextColumn: KanbanColumnId,
): KanbanTaskMock[] {
  return tasks.map((task) => (task.id === taskId ? { ...task, column: nextColumn } : task));
}

export function previewTaskTransition(
  request: KanbanConsoleTaskTransitionRequest,
): KanbanConsoleTaskTransitionResult {
  if (request.fromColumn === request.toColumn) {
    return {
      taskId: request.taskId,
      fromColumn: request.fromColumn,
      toColumn: request.toColumn,
      action: "none",
      requiresConfirmation: false,
      duplicateSuppressed: true,
      message: "Task is already in the requested column.",
    };
  }

  if (request.toColumn === "done" && !request.confirmed) {
    return {
      taskId: request.taskId,
      fromColumn: request.fromColumn,
      toColumn: request.toColumn,
      action: "open-action-sheet",
      requiresConfirmation: true,
      duplicateSuppressed: false,
      message: "Completion requires release and PR readiness confirmation.",
    };
  }

  if (request.toColumn === "blocked") {
    return {
      taskId: request.taskId,
      fromColumn: request.fromColumn,
      toColumn: request.toColumn,
      action: "open-action-sheet",
      requiresConfirmation: true,
      duplicateSuppressed: false,
      message: "Blocked transitions require a clear blocker reason.",
    };
  }

  return {
    taskId: request.taskId,
    fromColumn: request.fromColumn,
    toColumn: request.toColumn,
    action: "queue-agent-workflow",
    requiresConfirmation: !request.confirmed,
    duplicateSuppressed: false,
    message: "Transition can queue a confirmed agent workflow.",
  };
}

export function getPrWatchHealth(watch: KanbanConsolePullRequestWatch): KanbanConsolePrWatchHealth {
  if (watch.checks.some((check) => check.status === "failing")) {
    return "attention";
  }
  if (watch.checks.some((check) => check.status === "pending")) {
    return "pending";
  }
  return "green";
}

export function isSuggestedFixEligible(fix: KanbanConsoleSuggestedFix): boolean {
  return fix.status === "eligible" && !fix.guardrails.includes("protected-branch");
}

export function getTaskTitle(task: KanbanTaskMock, locale: KanbanConsoleLocale): string {
  return locale === "ar" ? task.titleAr : task.title;
}
