import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDotIcon,
  ClipboardListIcon,
  FileTextIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  KanbanSquareIcon,
  LanguagesIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  LockIcon,
  PlayIcon,
  RocketIcon,
  Settings2Icon,
  ShieldAlertIcon,
  SidebarIcon,
  TerminalSquareIcon,
} from "lucide-react";

import {
  consoleStateIds,
  consoleViews,
  getLocaleDirection,
  getMessages,
  getTasksByColumn,
  getTaskTitle,
  kanbanConsoleMockProvider,
  kanbanColumns,
  kanbanTasks,
  monorepos,
  moveTaskToColumn,
  type ConsoleStateId,
  type ConsoleViewId,
  type KanbanColumnId,
  type KanbanConsoleLocale,
  type KanbanTaskMock,
} from "../kanbanConsoleMock";
import { isElectron } from "../env";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetTitle,
} from "./ui/sheet";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { cn } from "~/lib/utils";

const viewIcons: Record<ConsoleViewId, typeof KanbanSquareIcon> = {
  artifacts: FileTextIcon,
  board: KanbanSquareIcon,
  cli: TerminalSquareIcon,
  git: GitBranchIcon,
  gitops: RocketIcon,
  prs: GitPullRequestIcon,
  settings: Settings2Icon,
  states: LayoutDashboardIcon,
  timeline: ActivityIcon,
};

const stateIcons: Record<ConsoleStateId, typeof CircleDotIcon> = {
  empty: CircleDotIcon,
  error: AlertTriangleIcon,
  loading: Loader2Icon,
  "missing-auth": LockIcon,
  permission: ShieldAlertIcon,
};

const stateTone: Record<ConsoleStateId, string> = {
  empty: "border-border bg-card",
  error: "border-destructive/30 bg-destructive/6 text-destructive-foreground",
  loading: "border-info/30 bg-info/6 text-info-foreground",
  "missing-auth": "border-warning/30 bg-warning/6 text-warning-foreground",
  permission: "border-warning/30 bg-warning/6 text-warning-foreground",
};

export function KanbanConsoleMock() {
  const [locale, setLocale] = useState<KanbanConsoleLocale>("en");
  const [activeView, setActiveView] = useState<ConsoleViewId>("board");
  const [tasks, setTasks] = useState<KanbanTaskMock[]>(() => [...kanbanTasks]);
  const [selectedTaskId, setSelectedTaskId] = useState(kanbanTasks[0]?.id ?? "");
  const [moveTaskId, setMoveTaskId] = useState<string | null>(null);
  const [queuedCommand, setQueuedCommand] = useState("/phase t3-kanban-project-console phase-3");
  const snapshot = kanbanConsoleMockProvider.readSnapshot();

  const messages = getMessages(locale);
  const direction = getLocaleDirection(locale);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const moveTask = moveTaskId ? tasks.find((task) => task.id === moveTaskId) : undefined;
  const groupedTasks = useMemo(() => getTasksByColumn(tasks), [tasks]);
  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const moveSelectedTask = (nextColumn: KanbanColumnId) => {
    if (!moveTask) return;
    setTasks((currentTasks) => moveTaskToColumn(currentTasks, moveTask.id, nextColumn));
    setSelectedTaskId(moveTask.id);
    setMoveTaskId(null);
  };

  const moveDraggedTask = (event: DragEndEvent) => {
    const taskId = String(event.active.id);
    const nextColumn = event.over?.id;

    if (!nextColumn || typeof nextColumn !== "string") {
      return;
    }

    if (!kanbanColumns.some((column) => column.id === nextColumn)) {
      return;
    }

    const targetTask = tasks.find((task) => task.id === taskId);
    if (!targetTask || targetTask.column === nextColumn) {
      return;
    }

    setTasks((currentTasks) =>
      moveTaskToColumn(currentTasks, taskId, nextColumn as KanbanColumnId),
    );
    setSelectedTaskId(taskId);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
        dir={direction}
      >
        <header
          className={cn(
            "border-b border-border bg-card/60 px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {!isElectron ? <SidebarTrigger className="size-7 shrink-0 md:hidden" /> : null}
            <KanbanSquareIcon className="size-4 text-primary" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">{messages.consoleTitle}</h1>
              <p className="hidden text-xs text-muted-foreground md:block">
                Phase 2 mock surface: no live GitHub, git, CLI, or provider mutations.
              </p>
            </div>
            <Button
              className="ms-auto"
              size="xs"
              variant="outline"
              onClick={() => setLocale((current) => (current === "en" ? "ar" : "en"))}
            >
              <LanguagesIcon />
              {locale === "en" ? "AR" : "EN"}
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[16rem_minmax(0,1fr)_22rem]">
          <ProjectSidebar />

          <main className="min-h-0 min-w-0 overflow-hidden border-x border-border">
            <div className="flex min-h-0 h-full flex-col">
              <ViewTabs activeView={activeView} locale={locale} onViewChange={setActiveView} />
              <section className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
                {activeView === "board" ? (
                  <DndContext sensors={dragSensors} onDragEnd={moveDraggedTask}>
                    <BoardView
                      groupedTasks={groupedTasks}
                      locale={locale}
                      onMoveTask={setMoveTaskId}
                      onSelectTask={setSelectedTaskId}
                      selectedTaskId={selectedTask?.id ?? null}
                    />
                  </DndContext>
                ) : null}
                {activeView === "git" ? <GitView locale={locale} snapshot={snapshot} /> : null}
                {activeView === "artifacts" ? (
                  <ArtifactsView locale={locale} snapshot={snapshot} />
                ) : null}
                {activeView === "prs" ? (
                  <PrWatcherView locale={locale} snapshot={snapshot} />
                ) : null}
                {activeView === "timeline" ? <TimelineView locale={locale} /> : null}
                {activeView === "cli" ? (
                  <CliView
                    locale={locale}
                    queuedCommand={queuedCommand}
                    onQueueCommand={setQueuedCommand}
                  />
                ) : null}
                {activeView === "gitops" ? (
                  <GitOpsView locale={locale} snapshot={snapshot} />
                ) : null}
                {activeView === "settings" ? (
                  <SettingsView locale={locale} snapshot={snapshot} />
                ) : null}
                {activeView === "states" ? <StatePreviewView locale={locale} /> : null}
              </section>
            </div>
          </main>

          <TaskDetailPanel locale={locale} task={selectedTask ?? null} />
        </div>
      </div>

      <Sheet open={Boolean(moveTask)} onOpenChange={(open) => !open && setMoveTaskId(null)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{messages.moveSheetTitle}</SheetTitle>
            <SheetDescription>
              {moveTask ? getTaskTitle(moveTask, locale) : messages.emptyState}
            </SheetDescription>
          </SheetHeader>
          <SheetPanel className="space-y-2">
            {kanbanColumns.map((column) => (
              <Button
                key={column.id}
                className="w-full justify-between"
                disabled={moveTask?.column === column.id}
                variant={moveTask?.column === column.id ? "secondary" : "outline"}
                onClick={() => moveSelectedTask(column.id)}
              >
                {messages[column.labelKey]}
                <ChevronRightIcon />
              </Button>
            ))}
          </SheetPanel>
          <SheetFooter>
            <Button variant="ghost" onClick={() => setMoveTaskId(null)}>
              Cancel
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </SidebarInset>
  );
}

function ProjectSidebar() {
  return (
    <aside className="hidden min-h-0 overflow-auto bg-card/30 p-3 lg:block">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <SidebarIcon className="size-4" />
        Registered monorepos
      </div>
      <div className="space-y-2">
        {monorepos.map((repo) => (
          <button
            key={repo.name}
            className="w-full rounded-md border border-border bg-background/70 p-3 text-start transition hover:bg-accent/60"
            type="button"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{repo.name}</span>
              <Badge
                variant={
                  repo.status === "healthy"
                    ? "success"
                    : repo.status === "attention"
                      ? "warning"
                      : "error"
                }
              >
                {repo.status}
              </Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{repo.path}</p>
            <div className="mt-2 grid grid-cols-3 gap-1 text-xs text-muted-foreground">
              <span>{repo.openPrs} PRs</span>
              <span>{repo.activeTasks} tasks</span>
              <span>
                +{repo.ahead}/-{repo.behind}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function ViewTabs({
  activeView,
  locale,
  onViewChange,
}: {
  activeView: ConsoleViewId;
  locale: KanbanConsoleLocale;
  onViewChange: (view: ConsoleViewId) => void;
}) {
  const messages = getMessages(locale);

  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card/30 px-3 py-2">
      {consoleViews.map((view) => {
        const Icon = viewIcons[view.id];
        return (
          <Button
            key={view.id}
            size="xs"
            variant={activeView === view.id ? "secondary" : "ghost"}
            onClick={() => onViewChange(view.id)}
          >
            <Icon />
            {messages[view.labelKey]}
          </Button>
        );
      })}
    </nav>
  );
}

function BoardView({
  groupedTasks,
  locale,
  onMoveTask,
  onSelectTask,
  selectedTaskId,
}: {
  groupedTasks: ReturnType<typeof getTasksByColumn>;
  locale: KanbanConsoleLocale;
  onMoveTask: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  selectedTaskId: string | null;
}) {
  const messages = getMessages(locale);

  return (
    <div className="space-y-3">
      <SectionHeading icon={KanbanSquareIcon} title={messages.boardHeading} />
      <div className="grid auto-cols-[minmax(16rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
        {groupedTasks.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            locale={locale}
            onMoveTask={onMoveTask}
            onSelectTask={onSelectTask}
            selectedTaskId={selectedTaskId}
          />
        ))}
      </div>
    </div>
  );
}

function KanbanColumn({
  column,
  locale,
  onMoveTask,
  onSelectTask,
  selectedTaskId,
}: {
  column: ReturnType<typeof getTasksByColumn>[number];
  locale: KanbanConsoleLocale;
  onMoveTask: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  selectedTaskId: string | null;
}) {
  const messages = getMessages(locale);
  const { isOver, setNodeRef } = useDroppable({
    id: column.id,
  });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "min-h-[34rem] rounded-md border bg-card/50 transition-colors",
        isOver ? "border-primary/70 bg-primary/6" : "border-border",
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{messages[column.labelKey]}</h2>
        <Badge variant="outline">{column.tasks.length}</Badge>
      </div>
      <div className="space-y-2 p-2">
        {column.tasks.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
            {messages.emptyState}
          </div>
        ) : null}
        {column.tasks.map((task) => (
          <TaskCard
            key={task.id}
            locale={locale}
            selected={selectedTaskId === task.id}
            task={task}
            onMoveTask={onMoveTask}
            onSelectTask={onSelectTask}
          />
        ))}
      </div>
    </section>
  );
}

function TaskCard({
  locale,
  onMoveTask,
  onSelectTask,
  selected,
  task,
}: {
  locale: KanbanConsoleLocale;
  onMoveTask: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  selected: boolean;
  task: KanbanTaskMock;
}) {
  const messages = getMessages(locale);
  const { attributes, isDragging, listeners, setNodeRef, transform } = useDraggable({
    id: task.id,
  });
  const style = {
    transform: CSS.Translate.toString(transform),
  };

  return (
    <article
      ref={setNodeRef}
      className={cn(
        "touch-none rounded-md border bg-background p-3 shadow-xs/5 transition-shadow",
        isDragging ? "z-20 cursor-grabbing opacity-80 shadow-lg" : "cursor-grab",
        selected ? "border-primary/60 ring-1 ring-primary/30" : "border-border",
      )}
      style={style}
      {...attributes}
      {...listeners}
    >
      <button className="w-full text-start" type="button" onClick={() => onSelectTask(task.id)}>
        <div className="flex items-center justify-between gap-2">
          <Badge
            variant={task.priority === "P0" ? "error" : task.priority === "P1" ? "warning" : "info"}
          >
            {task.priority}
          </Badge>
          <span className="text-xs text-muted-foreground">{task.issue}</span>
        </div>
        <h3 className="mt-2 text-sm font-semibold leading-snug">{getTaskTitle(task, locale)}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{task.repo}</p>
      </button>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2Icon className="size-3.5 text-success-foreground" />
          {task.checks.passing}/{task.checks.pending}/{task.checks.failing}
        </div>
        <Button size="xs" variant="outline" onClick={() => onMoveTask(task.id)}>
          <ChevronRightIcon />
          {messages.actionMove}
        </Button>
      </div>
    </article>
  );
}

function TaskDetailPanel({
  locale,
  task,
}: {
  locale: KanbanConsoleLocale;
  task: KanbanTaskMock | null;
}) {
  const messages = getMessages(locale);

  if (!task) {
    return null;
  }

  return (
    <aside className="hidden min-h-0 overflow-auto bg-card/30 p-4 xl:block">
      <SectionHeading icon={ClipboardListIcon} title={messages.detailHeading} />
      <div className="mt-3 space-y-3">
        <div className="rounded-md border border-border bg-background p-3">
          <p className="text-xs text-muted-foreground">{task.issue}</p>
          <h2 className="mt-1 text-base font-semibold leading-tight">
            {getTaskTitle(task, locale)}
          </h2>
          <div className="mt-3 flex flex-wrap gap-1">
            <Badge variant="outline">{task.repo}</Badge>
            <Badge variant={task.priority === "P0" ? "error" : "warning"}>{task.priority}</Badge>
            <Badge variant="secondary">{task.agent}</Badge>
          </div>
        </div>
        <DetailBlock title={messages.issueFields}>
          <DetailRow label="Assignee" value={task.assignee} />
          <DetailRow label="Project field" value={task.column} />
          <DetailRow label="Updated" value={task.updated} />
          <DetailRow label="PR" value={task.pr ?? "No linked PR"} />
        </DetailBlock>
        <DetailBlock title={messages.checks}>
          <DetailRow label="Passing" value={String(task.checks.passing)} />
          <DetailRow label="Pending" value={String(task.checks.pending)} />
          <DetailRow label="Failing" value={String(task.checks.failing)} />
        </DetailBlock>
        <DetailBlock title={messages.agentActions}>
          <MockCommand label="/orchestrate t3-kanban-project-console" />
          <MockCommand label="/ship t3-kanban-project-console" />
          <MockCommand label="/extract-pr-learnings 1" />
        </DetailBlock>
      </div>
    </aside>
  );
}

function GitView({
  locale,
  snapshot,
}: {
  locale: KanbanConsoleLocale;
  snapshot: ReturnType<typeof kanbanConsoleMockProvider.readSnapshot>;
}) {
  const messages = getMessages(locale);
  const gitStatus = snapshot.gitStatuses[0];

  return (
    <MockPanel icon={GitBranchIcon} title={messages.gitHeading}>
      <div className="grid gap-3 lg:grid-cols-2">
        <DetailBlock title="Branch status">
          <DetailRow label="Current" value={gitStatus?.branch ?? "unknown"} />
          <DetailRow label="Upstream" value={gitStatus?.upstream ?? "none"} />
          <DetailRow label="Mode" value="mock read-only" />
        </DetailBlock>
        <DetailBlock title="Changed files">
          {gitStatus?.files.map((file) => (
            <div key={file.path} className="rounded border border-border bg-card px-2 py-1 text-xs">
              {file.path}
            </div>
          ))}
        </DetailBlock>
      </div>
    </MockPanel>
  );
}

function ArtifactsView({
  locale,
  snapshot,
}: {
  locale: KanbanConsoleLocale;
  snapshot: ReturnType<typeof kanbanConsoleMockProvider.readSnapshot>;
}) {
  const messages = getMessages(locale);

  return (
    <MockPanel icon={FileTextIcon} title={messages.artifactsHeading}>
      <div className="grid gap-3 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-2">
          {snapshot.artifacts.map((artifact) => (
            <button
              key={artifact.id}
              className="w-full rounded-md border border-border bg-card p-2 text-start text-sm"
              type="button"
            >
              {artifact.path}
            </button>
          ))}
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <div className="mb-2 flex gap-2">
            <Button size="xs" variant="outline">
              <FileTextIcon />
              {messages.actionPreview}
            </Button>
            <Button size="xs" variant="outline">
              <CheckCircle2Icon />
              {messages.actionSaveDraft}
            </Button>
          </div>
          <pre className="min-h-64 overflow-auto rounded bg-background p-3 text-xs">
            # Product artifact preview{"\n\n"}- Governance-linked planning notes{"\n"}- Mock editor
            only{"\n"}- No docs/product write until Phase 3 scope
          </pre>
        </div>
      </div>
    </MockPanel>
  );
}

function PrWatcherView({
  locale,
  snapshot,
}: {
  locale: KanbanConsoleLocale;
  snapshot: ReturnType<typeof kanbanConsoleMockProvider.readSnapshot>;
}) {
  const messages = getMessages(locale);

  return (
    <MockPanel icon={GitPullRequestIcon} title={messages.prsHeading}>
      <div className="grid gap-3 lg:grid-cols-3">
        {snapshot.prWatches.map((watch) => {
          const health = kanbanConsoleMockProvider.getPrWatchHealth(watch);
          return (
            <div key={watch.id} className="rounded-md border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{watch.pr}</h3>
                <Badge
                  variant={
                    health === "attention" ? "error" : health === "pending" ? "warning" : "success"
                  }
                >
                  {health}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{watch.title}</p>
            </div>
          );
        })}
      </div>
    </MockPanel>
  );
}

function TimelineView({ locale }: { locale: KanbanConsoleLocale }) {
  const messages = getMessages(locale);
  const events = [
    "Issue linked to governance task",
    "PR checks started",
    "Review comment addressed",
    "Release smoke queued",
  ];

  return (
    <MockPanel icon={ActivityIcon} title={messages.timelineHeading}>
      <div className="space-y-2">
        {events.map((event, index) => (
          <div key={event} className="flex gap-3 rounded-md border border-border bg-card p-3">
            <Badge variant="outline">{index + 1}</Badge>
            <div>
              <p className="text-sm font-medium">{event}</p>
              <p className="text-xs text-muted-foreground">
                Mock event stream from issue, PR, checks, and agent actions.
              </p>
            </div>
          </div>
        ))}
      </div>
    </MockPanel>
  );
}

function CliView({
  locale,
  onQueueCommand,
  queuedCommand,
}: {
  locale: KanbanConsoleLocale;
  onQueueCommand: (command: string) => void;
  queuedCommand: string;
}) {
  const messages = getMessages(locale);
  const commands = kanbanConsoleMockProvider.readSnapshot().commandRuns.map((run) => run.command);

  return (
    <MockPanel icon={TerminalSquareIcon} title={messages.cliHeading}>
      <div className="space-y-3">
        {commands.map((command) => (
          <button
            key={command}
            className="flex w-full items-center justify-between rounded-md border border-border bg-card p-3 text-start"
            type="button"
            onClick={() => onQueueCommand(command)}
          >
            <code className="text-xs">{command}</code>
            <Badge variant={queuedCommand === command ? "success" : "outline"}>dry-run</Badge>
          </button>
        ))}
        <div className="rounded-md border border-border bg-background p-3">
          <p className="text-xs font-medium">{messages.actionQueueCommand}</p>
          <code className="mt-2 block text-xs text-muted-foreground">{queuedCommand}</code>
        </div>
      </div>
    </MockPanel>
  );
}

function GitOpsView({
  locale,
  snapshot,
}: {
  locale: KanbanConsoleLocale;
  snapshot: ReturnType<typeof kanbanConsoleMockProvider.readSnapshot>;
}) {
  const messages = getMessages(locale);

  return (
    <MockPanel icon={RocketIcon} title={messages.gitopsHeading}>
      <div className="grid gap-3 md:grid-cols-3">
        {snapshot.releaseReadiness.gates.map((gate) => (
          <div key={gate.id} className="rounded-md border border-border bg-card p-3">
            <Badge
              variant={
                gate.status === "blocked"
                  ? "error"
                  : gate.status === "pending"
                    ? "warning"
                    : "success"
              }
            >
              {gate.status}
            </Badge>
            <h3 className="mt-3 text-sm font-semibold">{gate.label}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Mock health signal for release readiness.
            </p>
          </div>
        ))}
      </div>
    </MockPanel>
  );
}

function SettingsView({
  locale,
  snapshot,
}: {
  locale: KanbanConsoleLocale;
  snapshot: ReturnType<typeof kanbanConsoleMockProvider.readSnapshot>;
}) {
  const messages = getMessages(locale);
  const settings = [
    `Organization: ${snapshot.boards[0]?.owner ?? "MohAnghabo"}`,
    "Trusted bots: CodeRabbit, GitHub Actions",
    "Polling: 60 seconds",
    `Protected branches: ${snapshot.gitOpsPolicy.protectedBranches.join(", ")}`,
  ];

  return (
    <MockPanel icon={Settings2Icon} title={messages.settingsHeading}>
      <div className="grid gap-2">
        {settings.map((setting) => (
          <label
            key={setting}
            className="flex items-center justify-between rounded-md border border-border bg-card p-3 text-sm"
          >
            {setting}
            <input aria-label={setting} defaultChecked className="accent-primary" type="checkbox" />
          </label>
        ))}
      </div>
    </MockPanel>
  );
}

function StatePreviewView({ locale }: { locale: KanbanConsoleLocale }) {
  const messages = getMessages(locale);
  const stateLabels: Record<ConsoleStateId, string> = {
    empty: messages.emptyState,
    error: messages.errorState,
    loading: messages.loadingState,
    "missing-auth": messages.missingAuthState,
    permission: messages.permissionState,
  };

  return (
    <MockPanel icon={LayoutDashboardIcon} title={messages.statesHeading}>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {consoleStateIds.map((stateId) => {
          const Icon = stateIcons[stateId];
          return (
            <div key={stateId} className={cn("rounded-md border p-4", stateTone[stateId])}>
              <Icon className={cn("size-5", stateId === "loading" && "animate-spin")} />
              <h3 className="mt-3 text-sm font-semibold">{stateId}</h3>
              <p className="mt-1 text-xs">{stateLabels[stateId]}</p>
            </div>
          );
        })}
      </div>
    </MockPanel>
  );
}

function MockPanel({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: typeof CircleDotIcon;
  title: string;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading icon={icon} title={title} />
      <div className="rounded-md border border-border bg-background p-3">{children}</div>
    </div>
  );
}

function SectionHeading({ icon: Icon, title }: { icon: typeof CircleDotIcon; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-primary" />
      <h2 className="text-sm font-semibold">{title}</h2>
    </div>
  );
}

function DetailBlock({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="rounded-md border border-border bg-background p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}

function MockCommand({ label }: { label: string }) {
  return (
    <button
      className="flex w-full items-center justify-between gap-2 rounded border border-border bg-card px-2 py-1.5 text-start text-xs hover:bg-accent/60"
      type="button"
    >
      <code className="truncate">{label}</code>
      <PlayIcon className="size-3.5 text-muted-foreground" />
    </button>
  );
}
