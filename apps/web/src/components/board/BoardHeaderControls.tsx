import type {
  AgentSelection,
  EnvironmentApi,
  WorkflowBoardDigest,
  WorkflowBoardMetrics,
  WorkflowWebhookConfig,
} from "@t3tools/contracts";
import {
  BarChart2Icon,
  DownloadIcon,
  MoreHorizontalIcon,
  NewspaperIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  WandSparklesIcon,
  WebhookIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Textarea } from "~/components/ui/textarea";
import type { IntakeTicketInput } from "~/workflow/intakeState";

import { AddFromIssuesDialog } from "./AddFromIssuesDialog";
import { BoardDigestDialog } from "./BoardDigestDialog";
import { BoardMetricsDialog } from "./BoardMetricsDialog";
import { IntakeDialog } from "./IntakeDialog";
import { SelfImproveDialog } from "./SelfImproveDialog";
import { WebhookConfigDialog } from "./WebhookConfigDialog";

export interface BoardHeaderLane {
  readonly key: string;
  readonly name: string;
}

export interface NewTicketInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly initialLane: string;
  readonly dependsOn?: ReadonlyArray<string> | undefined;
  readonly tokenBudget?: number | undefined;
}

export interface BoardHeaderTicketOption {
  readonly ticketId: string;
  readonly title: string;
}

export const getDefaultInitialLane = (lanes: ReadonlyArray<BoardHeaderLane>): string | null =>
  lanes[0]?.key ?? null;

export function BoardHeaderControls({
  boardId,
  lanes,
  tickets = [],
  workflowEditorOpen = false,
  intakeDisabledReason,
  needsAttentionCount = 0,
  api,
  onCreateTicket,
  onCreateTicketAsync,
  onProposeTickets,
  onToggleWorkflowEditor,
  onFetchDigest,
  onFetchMetrics,
  onFetchWebhookConfig,
  boardHasSources = false,
  onRefresh,
}: {
  readonly boardId: string | null;
  readonly lanes: ReadonlyArray<BoardHeaderLane>;
  readonly tickets?: ReadonlyArray<BoardHeaderTicketOption>;
  readonly workflowEditorOpen?: boolean | undefined;
  readonly intakeDisabledReason?: string | undefined;
  readonly api?: EnvironmentApi | null | undefined;
  readonly onCreateTicket: (input: NewTicketInput) => void;
  readonly onCreateTicketAsync?: ((input: NewTicketInput) => Promise<string | void>) | undefined;
  readonly onProposeTickets?:
    | ((braindump: string, agent: AgentSelection) => Promise<ReadonlyArray<IntakeTicketInput>>)
    | undefined;
  readonly onToggleWorkflowEditor?: (() => void) | undefined;
  readonly needsAttentionCount?: number | undefined;
  readonly onFetchDigest?: (() => Promise<WorkflowBoardDigest>) | undefined;
  readonly onFetchMetrics?: ((windowDays: 1 | 7 | 30) => Promise<WorkflowBoardMetrics>) | undefined;
  readonly onFetchWebhookConfig?: ((rotate: boolean) => Promise<WorkflowWebhookConfig>) | undefined;
  readonly boardHasSources?: boolean | undefined;
  readonly onRefresh?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [activeDialog, setActiveDialog] = useState<
    null | "webhook" | "digest" | "insights" | "suggest" | "intake" | "add-from-issues"
  >(null);

  // Measured overflow: render the six secondary buttons inline when they fit,
  // otherwise collapse them into a single "More" menu. SSR / first paint is
  // always expanded (no probe) so the SSR snapshot tests see inline buttons.
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [initialLane, setInitialLane] = useState(() => getDefaultInitialLane(lanes) ?? "");
  const [dependsOn, setDependsOn] = useState<ReadonlyArray<string>>([]);
  const [tokenBudget, setTokenBudget] = useState("");

  useEffect(() => {
    if (lanes.some((lane) => lane.key === initialLane)) {
      return;
    }
    setInitialLane(getDefaultInitialLane(lanes) ?? "");
  }, [initialLane, lanes]);

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const canCreateTicket = Boolean(boardId && initialLane && trimmedTitle);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setInitialLane(getDefaultInitialLane(lanes) ?? "");
    setDependsOn([]);
    setTokenBudget("");
  };

  const handleCreateIntakeTickets = async (
    tickets: ReadonlyArray<{
      readonly title: string;
      readonly description?: string | undefined;
      readonly dependsOnIndices: ReadonlyArray<number>;
    }>,
  ) => {
    const lane = getDefaultInitialLane(lanes);
    if (lane === null) {
      return;
    }
    // Sequential so dependency edges can reference the ids of the tickets
    // created earlier in this same batch.
    const createdIds: Array<string | undefined> = [];
    for (const ticket of tickets) {
      const dependsOn = ticket.dependsOnIndices
        .map((index) => createdIds[index])
        .filter((ticketId): ticketId is string => ticketId !== undefined);
      const input = {
        title: ticket.title,
        ...(ticket.description === undefined ? {} : { description: ticket.description }),
        initialLane: lane,
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      };
      if (onCreateTicketAsync) {
        createdIds.push((await onCreateTicketAsync(input)) ?? undefined);
      } else {
        onCreateTicket(input);
        createdIds.push(undefined);
      }
    }
  };

  // Secondary actions, in render order. Only include an action when its
  // handler/prop is present, matching the previous conditional rendering.
  interface SecondaryAction {
    readonly key: string;
    readonly label: string;
    readonly icon: ComponentType<{ className?: string }>;
    readonly disabled: boolean;
    readonly onSelect: () => void;
    readonly pressed?: boolean;
    readonly title?: string;
    readonly badge?: number;
  }

  const secondaryActions: ReadonlyArray<SecondaryAction> = [
    ...(onFetchWebhookConfig
      ? [
          {
            key: "webhook",
            label: "Webhook",
            icon: WebhookIcon,
            disabled: !boardId,
            onSelect: () => setActiveDialog("webhook"),
            title: "Let CI, PR automation, or cron move tickets on this board",
          } satisfies SecondaryAction,
        ]
      : []),
    ...(onFetchDigest
      ? [
          {
            key: "digest",
            label: "Digest",
            icon: NewspaperIcon,
            disabled: !boardId,
            onSelect: () => setActiveDialog("digest"),
            title: "What happened on this board in the last 24 hours",
            ...(needsAttentionCount > 0 ? { badge: needsAttentionCount } : {}),
          } satisfies SecondaryAction,
        ]
      : []),
    ...(onFetchMetrics
      ? [
          {
            key: "insights",
            label: "Insights",
            icon: BarChart2Icon,
            disabled: !boardId,
            onSelect: () => setActiveDialog("insights"),
            title: "Board metrics and throughput charts",
          } satisfies SecondaryAction,
        ]
      : []),
    ...(onToggleWorkflowEditor
      ? [
          {
            key: "edit-workflow",
            label: "Edit workflow",
            icon: PencilIcon,
            disabled: !boardId,
            onSelect: onToggleWorkflowEditor,
            pressed: workflowEditorOpen,
          } satisfies SecondaryAction,
        ]
      : []),
    ...(api !== undefined
      ? [
          {
            key: "suggest",
            label: "Suggest improvements",
            icon: WandSparklesIcon,
            disabled: !boardId,
            onSelect: () => setActiveDialog("suggest"),
            title: boardId ? "Suggest AI improvements to this board" : "No board selected",
          } satisfies SecondaryAction,
        ]
      : []),
    ...(onProposeTickets
      ? [
          {
            key: "intake",
            label: "Intake",
            icon: SparklesIcon,
            disabled: !boardId || lanes.length === 0 || intakeDisabledReason !== undefined,
            onSelect: () => setActiveDialog("intake"),
            title:
              intakeDisabledReason !== undefined
                ? intakeDisabledReason
                : "Turn a braindump into tickets",
          } satisfies SecondaryAction,
        ]
      : []),
    ...(boardHasSources && boardId
      ? [
          {
            key: "add-from-issues",
            label: "Add from issues",
            icon: DownloadIcon,
            disabled: false,
            onSelect: () => setActiveDialog("add-from-issues"),
            title: "Import work items from connected sources",
          } satisfies SecondaryAction,
        ]
      : []),
  ];

  // Re-measure on mount and whenever the container resizes (sidebar toggle,
  // board-name length change, window resize). The probe holds the full inline
  // layout off-screen so its scrollWidth is the natural required width.
  useLayoutEffect(() => {
    if (!mounted) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const measure = () => {
      const probe = probeRef.current;
      const node = containerRef.current;
      if (!probe || !node) {
        return;
      }
      // +4px buffer avoids flicker right at the boundary.
      setCollapsed(probe.scrollWidth + 4 > node.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [mounted, secondaryActions.length]);

  const renderInlineAction = (action: SecondaryAction) => (
    <Button
      key={action.key}
      type="button"
      size="xs"
      variant={action.key === "edit-workflow" && action.pressed ? "secondary" : "outline"}
      disabled={action.disabled}
      {...(action.title !== undefined ? { title: action.title } : {})}
      {...(action.key === "edit-workflow" ? { "aria-pressed": action.pressed } : {})}
      onClick={action.onSelect}
    >
      <action.icon className="size-3.5" />
      {action.label}
      {action.badge !== undefined ? (
        <Badge size="sm" variant="warning" data-testid="board-needs-attention-count">
          {action.badge}
        </Badge>
      ) : null}
    </Button>
  );

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center justify-end gap-2">
      {/* Off-screen probe: the full inline secondary layout, measured for fit. */}
      {mounted && secondaryActions.length > 0 ? (
        <div
          ref={probeRef}
          aria-hidden
          className="pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-2"
        >
          {secondaryActions.map(renderInlineAction)}
        </div>
      ) : null}

      {secondaryActions.length > 0 ? (
        collapsed ? (
          <Menu>
            <MenuTrigger
              render={
                <Button type="button" size="xs" variant="outline" aria-label="More board actions" />
              }
            >
              <MoreHorizontalIcon className="size-3.5" />
              More
            </MenuTrigger>
            <MenuPopup align="end">
              {secondaryActions.map((action) => (
                <MenuItem
                  key={action.key}
                  disabled={action.disabled}
                  onClick={action.onSelect}
                  {...(action.title !== undefined ? { title: action.title } : {})}
                >
                  <action.icon className="size-4" />
                  {action.label}
                  {action.badge !== undefined ? (
                    <Badge size="sm" variant="warning" data-testid="board-needs-attention-count">
                      {action.badge}
                    </Badge>
                  ) : null}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : (
          secondaryActions.map(renderInlineAction)
        )
      ) : null}

      {/* Controlled dialog bodies — rendered once regardless of collapse so a
          menu close never unmounts an open dialog. */}
      {onFetchWebhookConfig ? (
        <WebhookConfigDialog
          disabled={!boardId}
          onFetchConfig={onFetchWebhookConfig}
          open={activeDialog === "webhook"}
          onOpenChange={(o) => setActiveDialog(o ? "webhook" : null)}
        />
      ) : null}
      {onFetchDigest ? (
        <BoardDigestDialog
          disabled={!boardId}
          needsAttentionCount={needsAttentionCount}
          onFetchDigest={onFetchDigest}
          open={activeDialog === "digest"}
          onOpenChange={(o) => setActiveDialog(o ? "digest" : null)}
        />
      ) : null}
      {onFetchMetrics ? (
        <BoardMetricsDialog
          disabled={!boardId}
          onFetchMetrics={onFetchMetrics}
          open={activeDialog === "insights"}
          onOpenChange={(o) => setActiveDialog(o ? "insights" : null)}
        />
      ) : null}
      {api !== undefined ? (
        <SelfImproveDialog
          boardId={boardId}
          disabled={!boardId}
          api={api}
          open={activeDialog === "suggest"}
          onOpenChange={(o) => setActiveDialog(o ? "suggest" : null)}
        />
      ) : null}
      {onProposeTickets ? (
        <IntakeDialog
          disabled={!boardId || lanes.length === 0 || intakeDisabledReason !== undefined}
          disabledReason={intakeDisabledReason}
          onPropose={onProposeTickets}
          onCreateTickets={handleCreateIntakeTickets}
          open={activeDialog === "intake"}
          onOpenChange={(o) => setActiveDialog(o ? "intake" : null)}
        />
      ) : null}
      {boardHasSources && boardId ? (
        <AddFromIssuesDialog
          boardId={boardId}
          api={api}
          open={activeDialog === "add-from-issues"}
          onOpenChange={(o) => setActiveDialog(o ? "add-from-issues" : null)}
          onImported={() => onRefresh?.()}
        />
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            resetForm();
          }
        }}
      >
        <Button
          type="button"
          size="xs"
          disabled={!boardId || lanes.length === 0}
          onClick={() => setOpen(true)}
        >
          <PlusIcon className="size-3.5" />
          New ticket
        </Button>
        <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-hidden">
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canCreateTicket) {
                return;
              }

              const parsedBudget = Number.parseInt(tokenBudget, 10);
              onCreateTicket({
                title: trimmedTitle,
                ...(trimmedDescription ? { description: trimmedDescription } : {}),
                initialLane,
                ...(dependsOn.length > 0 ? { dependsOn } : {}),
                ...(Number.isFinite(parsedBudget) && parsedBudget > 0
                  ? { tokenBudget: parsedBudget }
                  : {}),
              });
              resetForm();
              setOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>New ticket</DialogTitle>
              <DialogDescription>
                Capture the work request, context, and acceptance criteria before adding it to the
                board.
              </DialogDescription>
            </DialogHeader>
            <div
              className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-3"
              data-slot="dialog-panel"
            >
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Title</span>
                <Input
                  value={title}
                  placeholder="Ticket title"
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  aria-label="Ticket title"
                  autoFocus
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Description</span>
                <Textarea
                  value={description}
                  placeholder="Describe the work, useful context, and acceptance criteria."
                  onChange={(event) => setDescription(event.currentTarget.value)}
                  aria-label="Ticket description"
                  rows={8}
                />
              </label>
              {tickets.length > 0 ? (
                <fieldset className="grid gap-1.5">
                  <legend className="text-xs font-medium text-foreground">
                    Depends on (held until these land)
                  </legend>
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-border/70 p-2">
                    {tickets.map((option) => (
                      <label key={option.ticketId} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={dependsOn.includes(option.ticketId)}
                          onChange={(event) => {
                            // currentTarget is nulled before the updater runs.
                            const checked = event.currentTarget.checked;
                            setDependsOn((current) =>
                              checked
                                ? [...current, option.ticketId]
                                : current.filter((ticketId) => ticketId !== option.ticketId),
                            );
                          }}
                          aria-label={`Depends on ${option.title}`}
                        />
                        <span className="truncate">{option.title}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Token budget (optional)</span>
                <Input
                  value={tokenBudget}
                  type="number"
                  min={0}
                  step={1000}
                  placeholder="e.g. 500000 — agent steps block once usage reaches it"
                  onChange={(event) => setTokenBudget(event.currentTarget.value)}
                  aria-label="Token budget"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Initial lane</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:opacity-64"
                  value={initialLane}
                  disabled={lanes.length === 0}
                  onChange={(event) => setInitialLane(event.currentTarget.value)}
                  aria-label="Initial lane"
                >
                  {lanes.map((lane) => (
                    <option key={lane.key} value={lane.key}>
                      {lane.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  resetForm();
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canCreateTicket}>
                Create ticket
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
