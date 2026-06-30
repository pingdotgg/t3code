import { createFileRoute } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type AgentSelection,
  type BoardSnapshot,
  BoardId,
  EnvironmentId,
  type EnvironmentApi,
  LaneKey,
  MessageId,
  ProjectId,
  StepRunId,
  type TicketAttachment,
  TicketId,
  type WorkflowDefinitionEncoded,
  type WorkflowTicketDetailView,
} from "@t3tools/contracts";
import { DatabaseIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoardHeaderControls } from "../components/board/BoardHeaderControls";
import { BoardView } from "../components/board/BoardView";
import { WorkflowEditor } from "../components/board/editor/WorkflowEditor";
import { WorkflowEditorFullscreen } from "../components/board/editor/WorkflowEditorFullscreen";
import { TicketDrawer } from "../components/board/TicketDrawer";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { countNeedsAttention } from "../workflow/agingFormat";
import { useNowTick } from "../workflow/useNowTick";
import { emptyBoardState, type BoardState } from "../workflow/boardState";
import {
  answerTicketStep,
  createTicket,
  editTicket,
  editTicketMessage,
  moveTicket,
  postTicketMessage,
  resolveApproval,
  subscribeBoard,
} from "../workflow/boardRpc";
import { useEnvironmentQuery } from "../state/query";
import { workflowEnvironment } from "../state/workflow";
import { useWorkflowApi } from "../workflow/useWorkflowApi";
import { useProject } from "../state/entities";

export interface BoardRouteSearch {
  readonly boardId?: string | undefined;
  /** Deep-link target: opens this ticket's drawer on load (notifications/webhooks). */
  readonly ticket?: string | undefined;
}

export interface BoardRouteEmptyState {
  readonly title: string;
  readonly description: string | null;
}

export function getBoardRouteEmptyState(input: {
  readonly boardId: BoardId | null;
  readonly boardLoadError: string | null;
}): BoardRouteEmptyState | null {
  if (!input.boardId) {
    return {
      title: "No board selected.",
      description: null,
    };
  }

  if (input.boardLoadError) {
    return {
      title: "Board not found.",
      description: input.boardLoadError,
    };
  }

  return null;
}

const parseBoardRouteSearch = (search: Record<string, unknown>): BoardRouteSearch => {
  const boardId = typeof search.boardId === "string" ? search.boardId.trim() : "";
  const ticket = typeof search.ticket === "string" ? search.ticket.trim() : "";
  return { ...(boardId ? { boardId } : {}), ...(ticket ? { ticket } : {}) };
};

export interface BoardRouteAnswerInput {
  readonly stepRunId: string;
  readonly text?: string | undefined;
  readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
}

export interface BoardRouteEditInput {
  readonly ticketId: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}

export interface BoardRouteMessageEditInput {
  readonly ticketId: string;
  readonly messageId: string;
  readonly body: string;
}

const environmentApiUnavailable = () => new Error("Environment API unavailable.");

// Max consecutive 2s polls while waiting for a running agent step's dispatch
// thread to appear (~30s). Bounds the self-re-arming detail poll so a stalled
// dispatch can't refetch getTicketDetail forever for every open drawer.
const MAX_THREAD_POLL_ATTEMPTS = 15;

export const submitTicketAnswerFromBoardRoute = (
  api: Pick<EnvironmentApi, "workflow"> | null | undefined,
  input: BoardRouteAnswerInput,
  reloadTicketDetail: () => void,
): Promise<void> => {
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  return answerTicketStep(api as EnvironmentApi, {
    stepRunId: StepRunId.make(input.stepRunId),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
  }).then(reloadTicketDetail);
};

export const submitTicketEditFromBoardRoute = (
  api: Pick<EnvironmentApi, "workflow"> | null | undefined,
  input: BoardRouteEditInput,
  reloadTicketDetail: () => void,
): Promise<void> => {
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  return editTicket(api as EnvironmentApi, {
    ticketId: TicketId.make(input.ticketId),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
  }).then(reloadTicketDetail);
};

export const submitTicketMessageEditFromBoardRoute = (
  api: Pick<EnvironmentApi, "workflow"> | null | undefined,
  input: BoardRouteMessageEditInput,
  reloadTicketDetail: () => void,
): Promise<void> => {
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  return editTicketMessage(api as EnvironmentApi, {
    ticketId: TicketId.make(input.ticketId),
    messageId: MessageId.make(input.messageId),
    body: input.body,
  }).then(reloadTicketDetail);
};

function WorkflowBoardRouteView() {
  const { environmentId: rawEnvironmentId } = Route.useParams();
  const { boardId: rawBoardId, ticket: rawTicket } = Route.useSearch();
  const [selectedTicketId, setSelectedTicketId] = useState<TicketId | null>(null);
  const [ticketDetail, setTicketDetail] = useState<WorkflowTicketDetailView | null>(null);
  const [ticketDetailError, setTicketDetailError] = useState<string | null>(null);
  const [ticketDetailReloadKey, setTicketDetailReloadKey] = useState(0);
  const [boardLoadError, setBoardLoadError] = useState<string | null>(null);
  const [boardHasSources, setBoardHasSources] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Incremented each time the board-level "Set up a source" CTA is clicked.
  // Passed to WorkflowEditor so it can open the Sources wizard on mount.
  const [editorSourcesTrigger, setEditorSourcesTrigger] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const ticketStatusRef = useRef(new Map<string, string>());
  const selectedTicketIdRef = useRef<TicketId | null>(null);
  selectedTicketIdRef.current = selectedTicketId;
  const lastDetailTicketIdRef = useRef<string | null>(null);
  // Bounds the "wait for the dispatch thread" poll below so a step that never
  // gets a providerThreadId (stalled dispatch) can't re-poll getTicketDetail
  // every 2s for the lifetime of the open drawer.
  const threadPollAttemptsRef = useRef(0);
  const environmentId = useMemo(() => EnvironmentId.make(rawEnvironmentId), [rawEnvironmentId]);
  const boardId = useMemo(() => (rawBoardId ? BoardId.make(rawBoardId) : null), [rawBoardId]);

  // Workflow API facade (hook — called at top level, used in callbacks below).
  const api = useWorkflowApi(environmentId);
  // Full EnvironmentApi-shaped object for child components that expect the wide type.
  const routeApi = useMemo(() => ({ workflow: api }) as EnvironmentApi, [api]);

  // Board state from the folded subscription atom.
  const boardQuery = useEnvironmentQuery(
    boardId ? workflowEnvironment.board({ environmentId, input: { boardId } }) : null,
  );
  const state = boardQuery.data ?? emptyBoardState;

  // ticketCwd: derive from the board's projectId via the environmentProjects atom.
  // EnvironmentProject extends OrchestrationProjectShell which has `workspaceRoot`
  // (the equivalent of the old `cwd` field). Falls back to undefined when the
  // board's projectId isn't yet populated or the project isn't in the catalog.
  const projectRef = useMemo(
    () =>
      state.projectId
        ? scopeProjectRef(environmentId, ProjectId.make(state.projectId))
        : null,
    [environmentId, state.projectId],
  );
  const projectData = useProject(projectRef);
  const ticketCwd = projectData?.workspaceRoot ?? undefined;

  const emptyState = getBoardRouteEmptyState({ boardId, boardLoadError });

  useEffect(() => {
    setBoardLoadError(null);
    if (!boardId) {
      setEditorOpen(false);
      return;
    }

    let cancelled = false;
    void api.getBoard({ boardId }).then(
      () => {
        if (!cancelled) {
          setBoardLoadError(null);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setBoardLoadError(errorMessage(error));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [boardId, environmentId, api]);

  useEffect(() => {
    setBoardHasSources(false);
    if (!boardId) {
      return;
    }

    let cancelled = false;
    void api.getBoardDefinition({ boardId }).then(
      ({ definition }: { definition: WorkflowDefinitionEncoded }) => {
        if (!cancelled) {
          setBoardHasSources((definition.sources?.length ?? 0) > 0);
        }
      },
      () => {
        // Silently ignore: the button simply won't appear if the definition
        // can't be loaded (e.g. network error, board not found).
        if (!cancelled) {
          setBoardHasSources(false);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [boardId, environmentId, api]);

  useEffect(() => {
    // The ticket drawer selection (and its detail/error state) is scoped to a
    // single board/environment. When either changes, close the drawer so it
    // can't linger open on a ticket that isn't part of the current board.
    setSelectedTicketId(null);
    setTicketDetail(null);
    setTicketDetailError(null);
  }, [boardId, environmentId]);

  useEffect(() => {
    // Deep link: a notification/webhook URL targets a specific ticket via the
    // `ticket` search param. Seed the drawer selection from it — declared AFTER
    // the board-switch reset above so it isn't immediately cleared on load.
    if (rawTicket) {
      setSelectedTicketId(TicketId.make(rawTicket));
    } else {
      // The `ticket` param is absent (e.g. back/forward navigation away from a
      // deep link) — treat its removal as authoritative and close the drawer so
      // stale detail can't linger. This effect re-runs only when rawTicket/board/
      // env change, so an in-app manual selection (which doesn't touch the param)
      // is never clobbered.
      setSelectedTicketId(null);
    }
  }, [rawTicket, boardId, environmentId]);

  useEffect(() => {
    if (!boardId) {
      return;
    }

    // Drop any ticket statuses carried over from a previously-viewed board so
    // stale ticket IDs can't fire spurious status-change toasts after a switch.
    ticketStatusRef.current.clear();

    return subscribeBoard(routeApi, environmentId, boardId, {
      onSnapshot: (snapshot) => {
        // Re-seed from scratch so the first ticket-stream update after a
        // snapshot reads as a transition (or not) against fresh statuses, and
        // so a re-snapshot for a new board never leaves stale entries behind.
        ticketStatusRef.current.clear();
        for (const ticket of snapshot.tickets) {
          ticketStatusRef.current.set(ticket.ticketId, ticket.status);
        }
      },
      onTicketUpdate: (ticket) => {
        if (ticket.ticketId === selectedTicketIdRef.current) {
          setTicketDetailReloadKey((key) => key + 1);
        }
        const previousStatus = ticketStatusRef.current.get(ticket.ticketId);
        ticketStatusRef.current.set(ticket.ticketId, ticket.status);
        notifyTicketStatusChange(ticket, previousStatus, selectedTicketIdRef.current);
      },
    });
  }, [boardId, environmentId, routeApi]);

  useEffect(() => {
    // A running agent step gets its dispatch thread shortly after StepStarted
    // is broadcast; poll the detail briefly so the live activity feed appears
    // without waiting for the next workflow event.
    if (!ticketDetail) {
      return;
    }
    const needsThread = ticketDetail.steps.some(
      (step) =>
        step.stepType === "agent" &&
        (step.status === "running" || step.status === "dispatch_requested") &&
        step.providerThreadId === undefined,
    );
    if (!needsThread) {
      // Thread arrived (or the step left the running/dispatch state): reset the
      // budget so a later step in the same ticket gets a fresh window.
      threadPollAttemptsRef.current = 0;
      return;
    }
    // Cap the poll. The thread normally appears within a couple of seconds; if a
    // dispatch stalls and never projects a providerThreadId, stop after ~30s
    // (workflow-event broadcasts still refresh the detail) instead of polling
    // getTicketDetail forever for every open drawer.
    if (threadPollAttemptsRef.current >= MAX_THREAD_POLL_ATTEMPTS) {
      return;
    }
    const timer = setTimeout(() => {
      threadPollAttemptsRef.current += 1;
      setTicketDetailReloadKey((key) => key + 1);
    }, 2_000);
    return () => clearTimeout(timer);
  }, [ticketDetail]);

  const visibleState = useMemo(
    () => filterBoardStateByQuery(state, searchQuery),
    [state, searchQuery],
  );

  useEffect(() => {
    if (!selectedTicketId) {
      lastDetailTicketIdRef.current = null;
      setTicketDetail(null);
      setTicketDetailError(null);
      return;
    }

    let cancelled = false;
    // Only clear the rendered detail when the selection actually changed
    // (scoped to the environment/board so stale detail never survives a
    // navigation); same-ticket revalidation keeps the previous detail (and
    // the drawer's in-progress state) while the refresh is in flight.
    const detailKey = `${environmentId}:${boardId ?? ""}:${selectedTicketId}`;
    if (lastDetailTicketIdRef.current !== detailKey) {
      lastDetailTicketIdRef.current = detailKey;
      // New ticket selected: restart the thread-poll budget.
      threadPollAttemptsRef.current = 0;
      setTicketDetail(null);
    }
    setTicketDetailError(null);

    void api.getTicketDetail({ ticketId: selectedTicketId }).then(
      (detail: WorkflowTicketDetailView) => {
        if (!cancelled) {
          setTicketDetail(detail);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setTicketDetailError(errorMessage(error));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [environmentId, boardId, selectedTicketId, ticketDetailReloadKey, api]);

  const handleMove = useCallback(
    (ticketId: string, toLane: string): Promise<void> => {
      // moveTicket fails on a not-found ticket (e.g. it was deleted, or already
      // moved by another client between render and drop). The drag/drop onMove
      // contract is fire-and-forget, so catch here: surface a brief toast and
      // refresh the board snapshot (the ticket may be gone or in a new lane)
      // instead of leaking an unhandled rejection or showing a scary error.
      return moveTicket(routeApi, TicketId.make(ticketId), LaneKey.make(toLane)).then(
        undefined,
        () => {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Couldn't move ticket",
              description: "It may have already moved or been deleted. Refreshing the board.",
            }),
          );
          if (boardId) {
            void api.getBoard({ boardId }).then(undefined, () => undefined);
          }
        },
      );
    },
    [environmentId, boardId, api, routeApi],
  );
  const handleOpenTicket = useCallback((ticketId: string) => {
    setEditorOpen(false);
    setSelectedTicketId(TicketId.make(ticketId));
  }, []);
  const closeTicketDrawer = useCallback(() => {
    setSelectedTicketId(null);
  }, []);
  const reloadTicketDetail = useCallback(() => {
    setTicketDetailReloadKey((key) => key + 1);
  }, []);
  const handleApprove = useCallback(
    (stepRunId: string, approved: boolean): Promise<void> => {
      return resolveApproval(routeApi, StepRunId.make(stepRunId), approved).then(reloadTicketDetail);
    },
    [routeApi, reloadTicketDetail],
  );
  const handleAnswerStep = useCallback(
    (input: BoardRouteAnswerInput): Promise<void> => {
      return submitTicketAnswerFromBoardRoute(routeApi, input, reloadTicketDetail);
    },
    [routeApi, reloadTicketDetail],
  );
  const handlePostComment = useCallback(
    (input: {
      readonly ticketId: string;
      readonly text?: string | undefined;
      readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
    }): Promise<void> => {
      return postTicketMessage(routeApi, {
        ticketId: TicketId.make(input.ticketId),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      }).then(reloadTicketDetail);
    },
    [routeApi, reloadTicketDetail],
  );
  const handleEditTicket = useCallback(
    (input: BoardRouteEditInput): Promise<void> => {
      return submitTicketEditFromBoardRoute(routeApi, input, reloadTicketDetail);
    },
    [routeApi, reloadTicketDetail],
  );
  const handleEditMessage = useCallback(
    (messageId: string, body: string): Promise<void> => {
      if (!selectedTicketId) {
        return Promise.reject(environmentApiUnavailable());
      }
      return submitTicketMessageEditFromBoardRoute(
        routeApi,
        { ticketId: selectedTicketId, messageId, body },
        reloadTicketDetail,
      );
    },
    [routeApi, reloadTicketDetail, selectedTicketId],
  );
  const handleRunLane = useCallback(() => {
    if (!selectedTicketId) {
      return;
    }

    // Mirror handleMove: a runLane RPC can reject (lane not runnable, script
    // trust revoked between render and click, server error). Surface a toast
    // and still reload the detail so the drawer reflects current state, instead
    // of leaking an unhandled rejection with no user feedback.
    void api.runLane({ ticketId: selectedTicketId }).then(reloadTicketDetail, (error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't run the lane",
          description: actionErrorMessage(error),
        }),
      );
      reloadTicketDetail();
    });
  }, [environmentId, reloadTicketDetail, selectedTicketId, api]);
  const handleDrawerMove = useCallback(
    (toLane: string): Promise<void> => {
      if (!selectedTicketId) {
        return Promise.resolve();
      }

      // Await the move RPC before reloading the detail so the drawer doesn't
      // briefly render the stale lane/actions while the move commits.
      return handleMove(selectedTicketId, toLane).then(reloadTicketDetail);
    },
    [handleMove, reloadTicketDetail, selectedTicketId],
  );
  const handleCreateTicket = useCallback(
    (input: {
      readonly title: string;
      readonly description?: string | undefined;
      readonly initialLane: string;
      readonly dependsOn?: ReadonlyArray<string> | undefined;
      readonly tokenBudget?: number | undefined;
    }) => {
      if (!boardId) {
        return;
      }

      // The New-ticket form closes its dialog synchronously after calling this,
      // so a rejected create (validation, duplicate, budget, server error) would
      // otherwise be fully silent. Surface a toast on failure instead of leaking
      // an unhandled rejection.
      void createTicket(routeApi, {
        boardId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        initialLane: LaneKey.make(input.initialLane),
        ...(input.dependsOn === undefined || input.dependsOn.length === 0
          ? {}
          : { dependsOn: input.dependsOn.map((ticketId) => TicketId.make(ticketId)) }),
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      }).then(undefined, (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Couldn't create "${input.title}"`,
            description: actionErrorMessage(error),
          }),
        );
      });
    },
    [boardId, routeApi],
  );
  const handleCreateTicketAsync = useCallback(
    async (input: {
      readonly title: string;
      readonly description?: string | undefined;
      readonly initialLane: string;
      readonly dependsOn?: ReadonlyArray<string> | undefined;
    }) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      const created = await createTicket(routeApi, {
        boardId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        initialLane: LaneKey.make(input.initialLane),
        ...(input.dependsOn === undefined || input.dependsOn.length === 0
          ? {}
          : { dependsOn: input.dependsOn.map((ticketId) => TicketId.make(ticketId)) }),
      });
      return created.ticketId as string;
    },
    [boardId, routeApi],
  );
  const handleProposeTickets = useCallback(
    async (braindump: string, agent: AgentSelection) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      const result = await api.intakeTickets({ boardId, braindump, agent });
      return result.proposals;
    },
    [boardId, api],
  );
  const handleFetchDigest = useCallback(async () => {
    if (!boardId) {
      throw new Error("No board selected.");
    }
    return await api.getBoardDigest({ boardId });
  }, [boardId, api]);
  const handleFetchMetrics = useCallback(
    async (windowDays: 1 | 7 | 30) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      return await api.getBoardMetrics({ boardId, windowDays });
    },
    [boardId, api],
  );
  const handleFetchWebhookConfig = useCallback(
    async (rotate: boolean) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      return await api.getWebhookConfig({ boardId, ...(rotate ? { rotate } : {}) });
    },
    [boardId, api],
  );
  const attentionNow = useNowTick(60_000);
  const needsAttentionCount = useMemo(
    () =>
      countNeedsAttention(
        state.ticketIds
          .map((ticketId) => state.ticketById[ticketId])
          .filter((ticket) => ticket !== undefined),
        attentionNow,
      ),
    [state.ticketIds, state.ticketById, attentionNow],
  );
  const handleRefresh = useCallback(() => {
    if (!boardId) {
      return;
    }
    void api.getBoard({ boardId }).then(undefined, () => undefined);
  }, [boardId, api]);

  const handleToggleWorkflowEditor = useCallback(() => {
    setEditorOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setSelectedTicketId(null);
      }
      return nextOpen;
    });
  }, []);

  /** Opens the editor directly to the Sources wizard (board empty-state CTA). */
  const handleOpenEditorToSources = useCallback(() => {
    setSelectedTicketId(null);
    setEditorOpen(true);
    setEditorSourcesTrigger((n) => n + 1);
  }, []);
  const handleWorkflowSaved = useCallback(
    (_snapshot: BoardSnapshot, definition: WorkflowDefinitionEncoded) => {
      // Board state is now maintained automatically by the folded board atom —
      // no manual applyBoardStreamItem or setProjectBoards side-effects needed.
      // Derive whether the board now has sources from the saved definition
      // rather than assuming any save implies sources exist — a lane rename or
      // settings change triggers onSaved too, and must not dismiss the CTA.
      setBoardHasSources((definition.sources?.length ?? 0) > 0);
    },
    [],
  );
  const closeWorkflowEditor = useCallback(() => {
    setEditorOpen(false);
  }, []);

  return (
    <>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-medium text-foreground">
                {state.boardName || "Workflow Board"}
              </h1>
            </div>
            {boardId ? (
              <Input
                aria-label="Search tickets"
                className="ml-auto h-7 w-44 max-w-[40vw] md:w-56"
                placeholder="Search tickets…"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
              />
            ) : null}
            <BoardHeaderControls
              boardId={boardId}
              lanes={state.lanes}
              tickets={state.ticketIds.map((ticketId) => ({
                ticketId,
                title: state.ticketById[ticketId]?.title ?? ticketId,
              }))}
              workflowEditorOpen={editorOpen}
              api={routeApi}
              onCreateTicket={handleCreateTicket}
              onProposeTickets={handleProposeTickets}
              onCreateTicketAsync={handleCreateTicketAsync}
              onToggleWorkflowEditor={handleToggleWorkflowEditor}
              needsAttentionCount={needsAttentionCount}
              onFetchDigest={handleFetchDigest}
              onFetchMetrics={handleFetchMetrics}
              onFetchWebhookConfig={handleFetchWebhookConfig}
              boardHasSources={boardHasSources}
              onRefresh={handleRefresh}
            />
          </header>
          {emptyState ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              <div className="max-w-md space-y-1">
                <div>{emptyState.title}</div>
                {emptyState.description ? (
                  <div className="text-xs text-muted-foreground/80">{emptyState.description}</div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <BoardView state={visibleState} onMove={handleMove} onOpen={handleOpenTicket} />
              {boardId && !boardHasSources ? (
                <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-2">
                  <p className="text-xs text-muted-foreground">
                    No sources configured. Tickets from GitHub Issues or Asana can be pulled in
                    automatically.
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    onClick={handleOpenEditorToSources}
                  >
                    <DatabaseIcon className="size-3.5" />
                    Set up a source
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </SidebarInset>
      <WorkflowEditorFullscreen open={editorOpen && boardId !== null} onClose={closeWorkflowEditor}>
        {boardId ? (
          <WorkflowEditor
            key={boardId}
            api={routeApi}
            boardId={boardId}
            onClose={closeWorkflowEditor}
            onSaved={handleWorkflowSaved}
            openSourcesWizardOnMount={editorSourcesTrigger}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            Environment API unavailable.
          </div>
        )}
      </WorkflowEditorFullscreen>
      <RightPanelSheet open={selectedTicketId !== null} onClose={closeTicketDrawer}>
        {ticketDetail ? (
          <TicketDrawer
            api={routeApi}
            detail={ticketDetail}
            lanes={state.lanes}
            onAnswerStep={handleAnswerStep}
            onPostComment={handlePostComment}
            onEditMessage={handleEditMessage}
            onApprove={handleApprove}
            onEditTicket={handleEditTicket}
            onMove={handleDrawerMove}
            onRunLane={handleRunLane}
            projectId={state.projectId ? ProjectId.make(state.projectId) : undefined}
            cwd={ticketCwd}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            {ticketDetailError ?? "Loading ticket..."}
          </div>
        )}
      </RightPanelSheet>
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load ticket detail.";
}

/** Error text for a failed action (create/run) toast, with a neutral fallback. */
function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function filterBoardStateByQuery(state: BoardState, query: string): BoardState {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return state;
  }
  const matches = (ticketId: string): boolean => {
    const ticket = state.ticketById[ticketId];
    if (!ticket) {
      return false;
    }
    return (
      ticket.title.toLowerCase().includes(needle) ||
      (ticket.description?.toLowerCase().includes(needle) ?? false)
    );
  };
  return {
    ...state,
    ticketIds: state.ticketIds.filter(matches),
    lanes: state.lanes.map((lane) => ({
      ...lane,
      admittedTicketIds: lane.admittedTicketIds.filter(matches),
      queuedTicketIds: lane.queuedTicketIds.filter(matches),
    })),
  };
}

function notifyTicketStatusChange(
  ticket: { readonly ticketId: string; readonly title: string; readonly status: string },
  previousStatus: string | undefined,
  openTicketId: TicketId | null,
): void {
  if (
    previousStatus === undefined ||
    previousStatus === ticket.status ||
    openTicketId === ticket.ticketId
  ) {
    return;
  }
  if (ticket.status === "waiting_on_user") {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: `"${ticket.title}" is waiting on you`,
        description: "Open the ticket to answer or approve.",
      }),
    );
    return;
  }
  if (ticket.status === "failed" || ticket.status === "blocked") {
    // Pipeline failures with no route project as "blocked", so both statuses
    // mean the same thing to the user: this ticket needs attention.
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `"${ticket.title}" needs attention`,
        description: "Open the ticket to see what went wrong.",
      }),
    );
  }
}

export const Route = createFileRoute("/_chat/$environmentId/board")({
  validateSearch: parseBoardRouteSearch,
  component: WorkflowBoardRouteView,
});
