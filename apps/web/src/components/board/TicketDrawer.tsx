import {
  ProjectId,
  StepRunId,
  type TicketAttachment,
  ThreadId,
  TicketId,
  type EnvironmentApi,
  type TerminalHistoryAttachStreamEvent,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ImageIcon,
  Maximize2Icon,
  Minimize2Icon,
  PencilIcon,
  PlayIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cn, randomUUID } from "~/lib/utils";
import { stepUsageSummary } from "~/workflow/usageFormat";

import {
  describeRouteDecision,
  extractVerdict,
  truncateLabel,
  type RouteDecisionView,
} from "~/workflow/routeDecision";

import { readFileAsDataUrl } from "../ChatView.logic";
import ChatMarkdown from "../ChatMarkdown";
import { AgentSessionDialog } from "./AgentSessionDialog";
import { MarkdownComposerField } from "./MarkdownComposerField";
import { TicketArtifacts } from "./TicketArtifacts";
import { StepActivityFeed } from "./StepActivityFeed";
import { TicketDiff } from "./TicketDiff";
import { WorkflowEditorFullscreen } from "./editor/WorkflowEditorFullscreen";

const SAFE_REPLY_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type TicketDrawerAttachment =
  | {
      readonly kind: "image";
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly dataUrl: string;
    }
  | {
      readonly kind: "video" | "file";
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly ref: string;
    };

export interface TicketDrawerAnswerInput {
  readonly stepRunId: string;
  readonly text?: string | undefined;
  readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
}

export interface TicketDrawerEditInput {
  readonly ticketId: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}

export interface TicketDrawerDetail {
  readonly ticket: {
    readonly ticketId: string;
    readonly boardId?: string | undefined;
    readonly title: string;
    readonly description?: string | undefined;
    readonly currentLaneKey: string;
    readonly status: string;
    readonly pr?:
      | {
          readonly number: number;
          readonly url: string;
          readonly state: "open" | "merged" | "closed";
          readonly ciState?: "pending" | "success" | "failure" | undefined;
        }
      | undefined;
  };
  readonly steps: ReadonlyArray<{
    readonly stepRunId: string;
    readonly stepKey: string;
    readonly stepType: string;
    readonly attempt?: number | undefined;
    readonly status: string;
    readonly waitingReason: string | null;
    readonly blockedReason?: string | null | undefined;
    readonly providerResponseKind?: "request" | "user-input" | null | undefined;
    readonly scriptThreadId?: string | null | undefined;
    readonly terminalId?: string | null | undefined;
    readonly scriptStatus?: string | null | undefined;
    readonly exitCode?: number | null | undefined;
    readonly signal?: number | null | undefined;
    readonly startedAt?: string | undefined;
    readonly finishedAt?: string | undefined;
    readonly usage?: { readonly totalTokens?: number | undefined } | undefined;
    readonly providerThreadId?: string | undefined;
    readonly output?: unknown;
  }>;
  readonly routeHistory?: ReadonlyArray<RouteDecisionView> | undefined;
  readonly messages?: ReadonlyArray<{
    readonly messageId: string;
    readonly ticketId: string;
    readonly stepRunId?: string | undefined;
    readonly author: "agent" | "user";
    readonly body: string;
    readonly attachments: ReadonlyArray<TicketDrawerAttachment>;
    readonly createdAt: string;
    readonly editedAt?: string | undefined;
  }>;
  readonly syncedSource?:
    | {
        readonly provider: string;
        readonly url: string;
        readonly assignees?: ReadonlyArray<string> | undefined;
        readonly labels?: ReadonlyArray<string> | undefined;
      }
    | undefined;
}

export interface TicketDrawerCommentInput {
  readonly ticketId: string;
  readonly text?: string | undefined;
  readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
}

/** Returns true when the ticket is owned by an external work-source sync and its
 *  title/description fields should be read-only in the UI. */
export function isTicketSourceOwned(detail: Pick<TicketDrawerDetail, "syncedSource">): boolean {
  return Boolean(detail.syncedSource);
}

export interface TicketDrawerLaneAction {
  readonly label: string;
  readonly to: string;
  readonly hint?: string | undefined;
}

export interface TicketDrawerLane {
  readonly key: string;
  readonly name: string;
  readonly entry: string;
  readonly pipelineStepCount: number;
  readonly actions?: ReadonlyArray<TicketDrawerLaneAction> | undefined;
}

export function TicketDrawer({
  api,
  detail,
  lanes = [],
  onAnswerStep,
  onPostComment,
  onEditMessage,
  onApprove,
  onEditTicket,
  onMove,
  onRunLane,
  projectId,
  cwd,
}: {
  readonly api?: EnvironmentApi | undefined;
  readonly detail: TicketDrawerDetail;
  readonly lanes?: ReadonlyArray<TicketDrawerLane>;
  readonly onAnswerStep?: ((input: TicketDrawerAnswerInput) => Promise<void>) | undefined;
  readonly onPostComment?: ((input: TicketDrawerCommentInput) => Promise<void>) | undefined;
  readonly onEditMessage?: ((messageId: string, body: string) => Promise<void>) | undefined;
  readonly onApprove: (stepRunId: string, approved: boolean) => Promise<void>;
  readonly onEditTicket?: ((input: TicketDrawerEditInput) => Promise<void>) | undefined;
  readonly onMove?: ((toLane: string) => void) | undefined;
  readonly onRunLane: () => void;
  readonly projectId?: ProjectId | undefined;
  readonly cwd?: string | undefined;
}) {
  const sourceOwned = isTicketSourceOwned(detail);
  const [fullscreen, setFullscreen] = useState(false);
  const [editingTicket, setEditingTicket] = useState(false);
  const [draftTitle, setDraftTitle] = useState(detail.ticket.title);
  const [draftDescription, setDraftDescription] = useState(detail.ticket.description ?? "");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<ReadonlyArray<TicketDrawerAttachment>>(
    [],
  );
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [approvalSubmittingStepRunId, setApprovalSubmittingStepRunId] = useState<string | null>(
    null,
  );
  const [approvalError, setApprovalError] = useState<{
    readonly stepRunId: string;
    readonly message: string;
  } | null>(null);
  const waitingStepCount = detail.steps.filter((step) => step.status === "awaiting_user").length;
  const currentLane = lanes.find((lane) => lane.key === detail.ticket.currentLaneKey) ?? null;
  const laneActions = currentLane?.actions ?? [];
  const canRunLane =
    currentLane !== null && currentLane.entry === "manual" && currentLane.pipelineStepCount > 0;
  const runLaneTitle = canRunLane
    ? `Run ${currentLane.name}`
    : "This lane has no manual pipeline to run.";
  const ticketDescription = detail.ticket.description?.trim() ?? "";
  const replyStep = detail.steps.find(isAwaitingUserInputStep) ?? null;
  const canReply = replyStep !== null && detail.ticket.status === "waiting_on_user";
  const laneDisplayName = (key: string): string =>
    lanes.find((lane) => lane.key === key)?.name ?? key;
  const routeHistory = detail.routeHistory ?? [];
  const latestRouteEntry = routeHistory.at(-1);
  const latestRouteDecision =
    latestRouteEntry === undefined
      ? null
      : describeRouteDecision(latestRouteEntry, laneDisplayName);

  useEffect(() => {
    if (editingTicket) {
      return;
    }
    setDraftTitle(detail.ticket.title);
    setDraftDescription(detail.ticket.description ?? "");
  }, [detail.ticket.description, detail.ticket.title, editingTicket]);

  const saveTicketEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = draftTitle.trim();
    if (!title || !onEditTicket) {
      return;
    }

    setEditSubmitting(true);
    setEditError(null);
    try {
      await onEditTicket({
        ticketId: detail.ticket.ticketId,
        title,
        description: draftDescription.trim(),
      });
      setEditingTicket(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Could not save ticket.");
    } finally {
      setEditSubmitting(false);
    }
  };

  const attachReplyImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) {
      return;
    }

    const images = files.filter((file) => SAFE_REPLY_IMAGE_MIME_TYPES.has(file.type));
    if (images.length !== files.length) {
      setReplyError("Only PNG, JPEG, GIF, or WebP image attachments are supported.");
    } else {
      setReplyError(null);
    }

    const nextAttachments = await Promise.all(
      images.map(async (file) => ({
        kind: "image" as const,
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type || "image/png",
        sizeBytes: file.size,
        dataUrl: await readFileAsDataUrl(file),
      })),
    );
    if (nextAttachments.length > 0) {
      setReplyAttachments((current) => [...current, ...nextAttachments]);
    }
  };

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = replyText.trim();
    if (!text && replyAttachments.length === 0) {
      return;
    }
    const attachmentsInput =
      replyAttachments.length > 0
        ? { attachments: replyAttachments as ReadonlyArray<TicketAttachment> }
        : {};

    setReplySubmitting(true);
    setReplyError(null);
    try {
      if (canReply && replyStep && onAnswerStep) {
        await onAnswerStep({
          stepRunId: replyStep.stepRunId,
          ...(text ? { text } : {}),
          ...attachmentsInput,
        });
      } else if (onPostComment) {
        await onPostComment({
          ticketId: detail.ticket.ticketId,
          ...(text ? { text } : {}),
          ...attachmentsInput,
        });
      } else {
        return;
      }
      setReplyText("");
      setReplyAttachments([]);
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : "Could not send message.");
    } finally {
      setReplySubmitting(false);
    }
  };

  const submitApproval = async (stepRunId: string, approved: boolean) => {
    setApprovalSubmittingStepRunId(stepRunId);
    setApprovalError(null);
    try {
      await onApprove(stepRunId, approved);
    } catch (error) {
      setApprovalError({
        stepRunId,
        message: error instanceof Error ? error.message : "Could not submit approval decision.",
      });
    } finally {
      setApprovalSubmittingStepRunId(null);
    }
  };

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* Minimal header — always visible so the expand/collapse control is always reachable. */}
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {detail.syncedSource ? (
              <p className="mb-1">
                <a
                  href={detail.syncedSource.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-sm border border-info/40 bg-info/8 px-1.5 py-0.5 text-[10px] font-medium text-info-foreground underline-offset-2 hover:underline"
                  data-testid="ticket-synced-source-badge"
                >
                  Synced from {detail.syncedSource.provider} ↗
                </a>
              </p>
            ) : null}
            <h2 className="truncate text-sm font-semibold text-foreground">
              {detail.ticket.title}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {detail.ticket.currentLaneKey} / {formatStatusLabel(detail.ticket.status)}
            </p>
            {detail.ticket.pr !== undefined ? (
              <TicketPrBadges pr={detail.ticket.pr} rowClassName="mt-1" testIds />
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {waitingStepCount > 0 ? (
              <Badge variant="warning" size="sm">
                waiting on you
              </Badge>
            ) : null}
            <div className="flex items-center gap-1.5">
              {!sourceOwned && !fullscreen ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!onEditTicket}
                  onClick={() => {
                    setEditError(null);
                    setEditingTicket(true);
                  }}
                >
                  <PencilIcon className="size-3.5" />
                  Edit ticket
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Expand ticket to full screen"
                title="Full screen"
                onClick={() => setFullscreen(true)}
              >
                <Maximize2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/*
       * When fullscreen is true: render only the TicketFullscreen overlay.
       * The heavy body (live thread subscriptions via StepActivityFeed, TicketDiff
       * fetches, TicketArtifacts) must NOT be mounted at the same time as the
       * fullscreen view to avoid duplicate live subscriptions and duplicate testids.
       */}
      {fullscreen ? (
        <TicketFullscreen
          api={api}
          detail={detail}
          lanes={lanes}
          laneDisplayName={laneDisplayName}
          laneActions={laneActions}
          canRunLane={canRunLane}
          runLaneTitle={runLaneTitle}
          routeHistory={routeHistory}
          latestRouteDecision={latestRouteDecision}
          ticketDescription={ticketDescription}
          editState={
            editingTicket
              ? {
                  draftTitle,
                  draftDescription,
                  editError,
                  editSubmitting,
                  setDraftTitle,
                  setDraftDescription,
                  saveTicketEdit,
                  cancelEdit: () => {
                    setDraftTitle(detail.ticket.title);
                    setDraftDescription(detail.ticket.description ?? "");
                    setEditError(null);
                    setEditingTicket(false);
                  },
                }
              : null
          }
          sourceOwned={sourceOwned}
          onStartEdit={
            !sourceOwned
              ? () => {
                  setEditError(null);
                  setEditingTicket(true);
                }
              : undefined
          }
          onEditTicket={onEditTicket}
          replyState={{
            canReply,
            replyText,
            setReplyText,
            replyAttachments,
            setReplyAttachments,
            replyError,
            replySubmitting,
            onAnswerStep,
            onPostComment,
            attachReplyImages,
            sendReply,
          }}
          approvalState={{
            approvalSubmittingStepRunId,
            approvalError,
            submitApproval,
          }}
          waitingStepCount={waitingStepCount}
          projectId={projectId}
          cwd={cwd}
          onEditMessage={onEditMessage}
          onMove={onMove}
          onRunLane={onRunLane}
          onClose={() => setFullscreen(false)}
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
            {editingTicket ? (
              <form className="space-y-2" onSubmit={saveTicketEdit}>
                <label className="block space-y-1 text-xs font-medium text-muted-foreground">
                  Ticket title
                  <Input
                    size="sm"
                    value={draftTitle}
                    disabled={sourceOwned || editSubmitting}
                    onChange={(event) => setDraftTitle(event.currentTarget.value)}
                  />
                </label>
                <label className="block space-y-1 text-xs font-medium text-muted-foreground">
                  Ticket description
                  <Textarea
                    size="sm"
                    value={draftDescription}
                    disabled={sourceOwned || editSubmitting}
                    onChange={(event) => setDraftDescription(event.currentTarget.value)}
                  />
                </label>
                {editError ? (
                  <p className="text-xs text-destructive-foreground">{editError}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    type="submit"
                    disabled={!draftTitle.trim() || !onEditTicket || editSubmitting}
                  >
                    <CheckIcon className="size-3.5" />
                    Save ticket
                  </Button>
                  <Button
                    size="xs"
                    type="button"
                    variant="outline"
                    disabled={editSubmitting}
                    onClick={() => {
                      setDraftTitle(detail.ticket.title);
                      setDraftDescription(detail.ticket.description ?? "");
                      setEditError(null);
                      setEditingTicket(false);
                    }}
                  >
                    <XIcon className="size-3.5" />
                    Cancel edit
                  </Button>
                </div>
              </form>
            ) : (
              <TicketDescriptionView description={ticketDescription} density="compact" />
            )}
            {latestRouteDecision ? (
              <section
                className="rounded-md border border-info/40 bg-info/5 p-3"
                data-testid="ticket-route-why"
              >
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Why is this ticket here?
                </h3>
                <p className="mt-1 text-sm font-medium text-foreground">
                  {latestRouteDecision.title}
                </p>
                {latestRouteDecision.details.length > 0 ? (
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {latestRouteDecision.details.join(" · ")}
                  </p>
                ) : null}
                <TicketRouteHistoryDetails
                  routeHistory={routeHistory}
                  laneDisplayName={laneDisplayName}
                  detailsClassName="mt-2"
                />
              </section>
            ) : null}
            <TicketDiscussionSection
              messages={detail.messages}
              density="compact"
              cwd={cwd}
              onEditMessage={onEditMessage}
            />

            {canReply || onPostComment ? (
              <TicketReplyComposer
                canReply={canReply}
                replyText={replyText}
                setReplyText={setReplyText}
                replyAttachments={replyAttachments}
                setReplyAttachments={setReplyAttachments}
                replyError={replyError}
                replySubmitting={replySubmitting}
                onAnswerStep={onAnswerStep}
                onPostComment={onPostComment}
                attachReplyImages={attachReplyImages}
                sendReply={sendReply}
                cwd={cwd}
                formClassName="p-3"
              />
            ) : null}

            <section className="rounded-md border border-border/70 bg-card/35 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground">Steps</h3>
                <span className="text-xs text-muted-foreground">{detail.steps.length}</span>
              </div>
              <ol className="space-y-2">
                {detail.steps.map((step) => (
                  <TicketStepRow
                    key={step.stepRunId}
                    step={step}
                    api={api}
                    projectId={projectId}
                    approvalSubmittingStepRunId={approvalSubmittingStepRunId}
                    approvalError={approvalError}
                    stepOutputTestId="step-captured-output"
                    onRunLane={onRunLane}
                    submitApproval={submitApproval}
                    liClassName="p-2"
                  />
                ))}
              </ol>
            </section>

            {api ? <TicketArtifacts api={api} ticketId={detail.ticket.ticketId} /> : null}
            {api ? <TicketDiff api={api} ticketId={TicketId.make(detail.ticket.ticketId)} /> : null}
          </div>
          <footer className="shrink-0 space-y-2 border-t border-border px-3 py-2">
            {onMove && laneActions.length > 0 ? (
              <div className="flex flex-wrap gap-2" data-testid="ticket-lane-actions">
                {laneActions.map((action) => {
                  const targetLane = lanes.find((lane) => lane.key === action.to);
                  const hint = [action.hint, targetLane ? `Moves to ${targetLane.name}.` : null]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <Button
                      key={`${action.label}:${action.to}`}
                      size="sm"
                      variant="outline"
                      title={hint}
                      onClick={() => onMove(action.to)}
                    >
                      {action.label}
                      {targetLane ? (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          → {targetLane.name}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!canRunLane} title={runLaneTitle} onClick={onRunLane}>
                <PlayIcon className="size-4" />
                Run lane
              </Button>
              {onMove && lanes.length > 0 ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Move
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    value={detail.ticket.currentLaneKey}
                    onChange={(event) => onMove(event.currentTarget.value)}
                  >
                    {lanes.map((lane) => (
                      <option key={lane.key} value={lane.key}>
                        {lane.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </footer>
        </>
      )}
    </aside>
  );
}

function TicketAttachmentPreview({ attachment }: { readonly attachment: TicketDrawerAttachment }) {
  if (attachment.kind === "image") {
    return (
      <div className="overflow-hidden rounded-md border border-border/70 bg-background">
        <img src={attachment.dataUrl} alt={attachment.name} className="size-20 object-cover" />
        <span className="block max-w-24 truncate px-1.5 py-1 text-[10px] text-muted-foreground">
          {attachment.name}
        </span>
      </div>
    );
  }

  return (
    <span className="rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-muted-foreground">
      {attachment.name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components used by both TicketDrawer and TicketFullscreen.
// Extracting these prevents JSX duplication and ensures bug fixes/additions
// only need to happen in one place.
// ---------------------------------------------------------------------------

/** Read-only description display. Used by both the drawer body and the fullscreen left column.
 *  `density="compact"` uses the drawer's tighter spacing (p-3, leading-5, h3).
 *  `density="spacious"` uses the fullscreen's roomier spacing (p-4, leading-6, h2). */
function TicketDescriptionView({
  description,
  density,
}: {
  readonly description: string;
  readonly density: "compact" | "spacious";
}) {
  if (!description) {
    return null;
  }
  if (density === "spacious") {
    return (
      <section
        className="rounded-md border border-border/70 bg-card/35 p-4"
        data-testid="ticket-description"
      >
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Description
        </h2>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
          {description}
        </p>
      </section>
    );
  }
  return (
    <section
      className="rounded-md border border-border/70 bg-card/35 p-3"
      data-testid="ticket-description"
    >
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Description
      </h3>
      <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
        {description}
      </p>
    </section>
  );
}

type TicketPrShape = NonNullable<TicketDrawerDetail["ticket"]["pr"]>;

/** The PR number link + state badge + optional CI-state badge row.
 *  Used in both the drawer header (with conditional `data-testid`s) and the
 *  fullscreen header (always with `data-testid`s). Pass `testIds` to render
 *  the `data-testid` attributes. `rowClassName` is applied to the outer `<p>`. */
function TicketPrBadges({
  pr,
  rowClassName,
  testIds,
}: {
  readonly pr: TicketPrShape;
  readonly rowClassName?: string | undefined;
  /** When true, renders `data-testid` attributes for automated tests. */
  readonly testIds?: boolean | undefined;
}) {
  return (
    <p
      className={cn("flex flex-wrap items-center gap-1.5 text-xs", rowClassName)}
      data-testid={testIds ? "ticket-pr-row" : undefined}
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-foreground underline-offset-2 hover:underline"
        data-testid={testIds ? "ticket-pr-link" : undefined}
      >
        PR #{pr.number}
      </a>
      <span
        className={cn(
          "rounded-sm border px-1 py-0.5 text-[10px] font-medium",
          pr.state === "merged"
            ? "border-muted-foreground/30 text-muted-foreground"
            : pr.state === "closed"
              ? "border-muted-foreground/30 text-muted-foreground/70"
              : "border-success/40 text-success-foreground",
        )}
        data-testid={testIds ? "ticket-pr-state" : undefined}
      >
        {pr.state}
      </span>
      {pr.ciState !== undefined ? (
        <span
          className={cn(
            "rounded-sm border px-1 py-0.5 text-[10px] font-medium",
            pr.ciState === "failure"
              ? "border-destructive/40 text-destructive-foreground"
              : pr.ciState === "success"
                ? "border-success/40 text-success-foreground"
                : "border-muted-foreground/30 text-muted-foreground",
          )}
          data-testid={testIds ? "ticket-pr-ci-state" : undefined}
        >
          CI: {pr.ciState}
        </span>
      ) : null}
    </p>
  );
}

type DiscussionMessage = NonNullable<TicketDrawerDetail["messages"]>[number];

/** True when the viewer may edit a comment: it is their own free-form comment
 *  (`author === "user"`) and not an answer captured against an agent step. */
function canEditDiscussionMessage(message: DiscussionMessage): boolean {
  return message.author === "user" && message.stepRunId == null;
}

/** The Discussion `<section>` with the message thread.
 *  `density="compact"` uses the drawer's tighter spacing (p-3 / ml-5).
 *  `density="spacious"` uses the fullscreen's roomier spacing (p-4 / ml-6). */
function TicketDiscussionSection({
  messages,
  density,
  cwd,
  onEditMessage,
}: {
  readonly messages?: ReadonlyArray<DiscussionMessage> | undefined;
  readonly density: "compact" | "spacious";
  readonly cwd?: string | undefined;
  readonly onEditMessage?: ((messageId: string, body: string) => Promise<void>) | undefined;
}) {
  const sectionPadding = density === "spacious" ? "p-4" : "p-3";
  const headerMargin = density === "spacious" ? "mb-3" : "mb-2";
  const itemPadding = density === "spacious" ? "p-3" : "p-2";
  const userIndent = density === "spacious" ? "ml-6" : "ml-5";
  const agentIndent = density === "spacious" ? "mr-6" : "mr-5";
  const Heading = density === "spacious" ? "h2" : "h3";
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  return (
    <section className={cn("rounded-md border border-border/70 bg-card/35", sectionPadding)}>
      <div className={cn("flex items-center justify-between gap-2", headerMargin)}>
        <Heading className="text-sm font-medium text-foreground">Discussion</Heading>
        <span className="text-xs text-muted-foreground">{messages?.length ?? 0}</span>
      </div>
      {messages && messages.length > 0 ? (
        <ol className="space-y-2">
          {messages.map((message) => (
            <li
              key={message.messageId}
              className={cn(
                "rounded-md border border-border/60 bg-background/70",
                itemPadding,
                message.author === "user" && `${userIndent} bg-accent/20`,
                message.author === "agent" && agentIndent,
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium uppercase tracking-wide">
                  {message.author === "agent" ? "Agent" : "You"}
                </span>
                <span className="flex items-center gap-1">
                  <time dateTime={message.createdAt}>
                    {formatMessageTimestamp(message.createdAt)}
                  </time>
                  {message.editedAt ? (
                    <span className="text-[11px] text-muted-foreground">· edited</span>
                  ) : null}
                  {onEditMessage &&
                  canEditDiscussionMessage(message) &&
                  editingMessageId !== message.messageId ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Edit comment"
                      title="Edit comment"
                      onClick={() => setEditingMessageId(message.messageId)}
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                  ) : null}
                </span>
              </div>
              {onEditMessage && editingMessageId === message.messageId ? (
                <DiscussionMessageEditForm
                  initialBody={message.body}
                  cwd={cwd}
                  onSave={(body) => onEditMessage(message.messageId, body)}
                  onClose={() => setEditingMessageId(null)}
                />
              ) : (
                <>
                  {message.body ? (
                    <ChatMarkdown
                      text={message.body}
                      cwd={cwd}
                      lineBreaks
                      className="text-sm leading-5"
                    />
                  ) : null}
                  {message.attachments.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.attachments.map((attachment) => (
                        <TicketAttachmentPreview key={attachment.id} attachment={attachment} />
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          No discussion yet — leave a note below for the agent or your future self.
        </p>
      )}
    </section>
  );
}

/** Inline edit form for a single discussion comment. Mirrors the reply
 *  composer's Write/Preview affordance and surfaces save failures inline. */
function DiscussionMessageEditForm({
  initialBody,
  cwd,
  onSave,
  onClose,
}: {
  readonly initialBody: string;
  readonly cwd?: string | undefined;
  readonly onSave: (body: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) {
      setError("Comment cannot be empty.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSave(body);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the comment.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-2" onSubmit={handleSubmit}>
      <MarkdownComposerField
        value={draft}
        onChange={setDraft}
        disabled={submitting}
        ariaLabel="Edit comment"
        cwd={cwd}
      />
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" type="submit" disabled={submitting || !draft.trim()}>
          <CheckIcon className="size-3.5" />
          Save
        </Button>
        <Button size="xs" type="button" variant="outline" disabled={submitting} onClick={onClose}>
          <XIcon className="size-3.5" />
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The collapsible `<details>` route-history list rendered inside the "Why is
 *  this ticket here?" section. Both drawer and fullscreen share this block. */
function TicketRouteHistoryDetails({
  routeHistory,
  laneDisplayName,
  detailsClassName,
}: {
  readonly routeHistory: ReadonlyArray<RouteDecisionView>;
  readonly laneDisplayName: (key: string) => string;
  readonly detailsClassName?: string | undefined;
}) {
  if (routeHistory.length <= 1) {
    return null;
  }
  return (
    <details className={detailsClassName}>
      <summary className="cursor-pointer text-xs text-muted-foreground select-none">
        Route history ({routeHistory.length})
      </summary>
      <ol className="mt-2 space-y-1.5">
        {routeHistory
          .map((entry) => describeRouteDecision(entry, laneDisplayName))
          .toReversed()
          .map((described, index) => {
            const entry = routeHistory[routeHistory.length - 1 - index];
            return (
              <li
                key={`${entry?.occurredAt ?? index}-${index}`}
                className="rounded-md border border-border/60 bg-background/70 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{described.title}</span>
                  {entry ? (
                    <time dateTime={entry.occurredAt} className="text-[11px] text-muted-foreground">
                      {formatMessageTimestamp(entry.occurredAt)}
                    </time>
                  ) : null}
                </div>
                {described.details.length > 0 ? (
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {described.details.join(" · ")}
                  </p>
                ) : null}
              </li>
            );
          })}
      </ol>
    </details>
  );
}

/** The reply / comment composer `<form>`. Both drawer (`p-3`) and fullscreen
 *  (`p-4`) use this form with their own padding class passed via `formClassName`. */
function TicketReplyComposer({
  canReply,
  replyText,
  setReplyText,
  replyAttachments,
  setReplyAttachments,
  replyError,
  replySubmitting,
  onAnswerStep,
  onPostComment,
  attachReplyImages,
  sendReply,
  cwd,
  formClassName,
}: {
  readonly canReply: boolean;
  readonly replyText: string;
  readonly setReplyText: (value: string) => void;
  readonly replyAttachments: ReadonlyArray<TicketDrawerAttachment>;
  readonly setReplyAttachments: (
    updater: (
      current: ReadonlyArray<TicketDrawerAttachment>,
    ) => ReadonlyArray<TicketDrawerAttachment>,
  ) => void;
  readonly replyError: string | null;
  readonly replySubmitting: boolean;
  readonly onAnswerStep?: ((input: TicketDrawerAnswerInput) => Promise<void>) | undefined;
  readonly onPostComment?: ((input: TicketDrawerCommentInput) => Promise<void>) | undefined;
  readonly attachReplyImages: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  readonly sendReply: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly cwd?: string | undefined;
  readonly formClassName?: string | undefined;
}) {
  return (
    <form
      className={cn(
        "rounded-md border",
        canReply ? "border-warning/40 bg-warning/5" : "border-border/70 bg-card/35",
        formClassName,
      )}
      onSubmit={sendReply}
    >
      <MarkdownComposerField
        value={replyText}
        onChange={setReplyText}
        disabled={replySubmitting}
        label={canReply ? "Ticket reply" : "Add a comment"}
        cwd={cwd}
      />
      {replyAttachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {replyAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="group relative overflow-hidden rounded-md border border-border/70 bg-background"
            >
              {attachment.kind === "image" ? (
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="size-16 object-cover"
                />
              ) : null}
              <span className="block max-w-24 truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                {attachment.name}
              </span>
              <Button
                className="absolute right-1 top-1 bg-background/85"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${attachment.name}`}
                disabled={replySubmitting}
                onClick={() =>
                  setReplyAttachments((current) =>
                    current.filter((candidate) => candidate.id !== attachment.id),
                  )
                }
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {replyError ? <p className="mt-2 text-xs text-destructive-foreground">{replyError}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground shadow-xs/5 hover:bg-accent/50">
          <ImageIcon className="size-3.5" aria-hidden />
          Attach image
          <input
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            disabled={replySubmitting}
            onChange={attachReplyImages}
          />
        </label>
        <Button
          size="xs"
          type="submit"
          disabled={
            (canReply ? !onAnswerStep : !onPostComment) ||
            replySubmitting ||
            (!replyText.trim() && replyAttachments.length === 0)
          }
        >
          <SendIcon className="size-3.5" />
          {canReply ? "Send reply" : "Comment"}
        </Button>
      </div>
    </form>
  );
}

type StepRowStep = TicketDrawerDetail["steps"][number];

/** A single step row `<li>`. Shared between the drawer and the fullscreen right
 *  column. The `liClassName` lets each context supply its own padding. */
function TicketStepRow({
  step,
  api,
  projectId,
  approvalSubmittingStepRunId,
  approvalError,
  stepOutputTestId,
  onRunLane,
  submitApproval,
  liClassName,
}: {
  readonly step: StepRowStep;
  readonly api?: EnvironmentApi | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly approvalSubmittingStepRunId: string | null;
  readonly approvalError: { readonly stepRunId: string; readonly message: string } | null;
  /** data-testid applied to the step output `<div>`. Pass undefined to omit. */
  readonly stepOutputTestId?: string | undefined;
  readonly onRunLane: () => void;
  readonly submitApproval: (stepRunId: string, approved: boolean) => Promise<void>;
  readonly liClassName?: string | undefined;
}) {
  return (
    <li
      className={cn(
        "rounded-md border border-border/60 bg-background/70",
        (step.status === "awaiting_user" || step.status === "blocked") &&
          "border-warning/45 bg-warning/5",
        liClassName,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{step.stepKey}</p>
          <p className="text-xs text-muted-foreground">
            {step.stepType}
            {step.attempt !== undefined && step.attempt > 1 ? ` · attempt ${step.attempt}` : null}
            {stepUsageSummary(step) !== null ? ` · ${stepUsageSummary(step)}` : null}
            {step.startedAt ? ` · started ${formatMessageTimestamp(step.startedAt)}` : null}
          </p>
        </div>
        <Badge size="sm" variant={stepBadgeVariant(step)}>
          {formatStepBadgeLabel(step)}
        </Badge>
      </div>
      {step.waitingReason ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.waitingReason}</p>
      ) : null}
      {step.blockedReason ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.blockedReason}</p>
      ) : null}
      {step.output !== undefined && step.output !== null ? (
        <div className="mt-2" data-testid={stepOutputTestId}>
          {extractVerdict(step.output) !== null ? (
            <Badge
              size="sm"
              variant={extractVerdict(step.output) === "approve" ? "success" : "warning"}
            >
              verdict: {truncateLabel(extractVerdict(step.output) ?? "")}
            </Badge>
          ) : null}
          <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border/60 bg-background/70 p-2 text-[11px] leading-4 text-muted-foreground">
            {JSON.stringify(step.output, null, 2)}
          </pre>
        </div>
      ) : null}
      {isScriptStepWithTerminal(step) ? <ScriptStepLogViewer api={api} step={step} /> : null}
      {step.stepType === "agent" &&
      step.providerThreadId !== undefined &&
      (step.status === "running" ||
        step.status === "dispatch_requested" ||
        step.status === "awaiting_user") ? (
        <StepActivityFeed api={api} threadId={step.providerThreadId as never} live />
      ) : null}
      {step.stepType === "agent" && step.providerThreadId !== undefined ? (
        <div className="mt-2">
          <AgentSessionDialog
            api={api}
            threadId={step.providerThreadId as never}
            stepKey={step.stepKey}
          />
        </div>
      ) : null}
      {isAwaitingApprovalRequestStep(step) ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="xs"
            disabled={approvalSubmittingStepRunId === step.stepRunId}
            onClick={() => {
              void submitApproval(step.stepRunId, true);
            }}
          >
            <CheckIcon className="size-3.5" />
            Approve
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={approvalSubmittingStepRunId === step.stepRunId}
            onClick={() => {
              void submitApproval(step.stepRunId, false);
            }}
          >
            <XIcon className="size-3.5" />
            Reject
          </Button>
          {approvalError?.stepRunId === step.stepRunId ? (
            <p className="basis-full text-xs text-destructive-foreground">
              {approvalError.message}
            </p>
          ) : null}
        </div>
      ) : null}
      {step.stepType === "script" && step.scriptStatus === "running" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!api}
            onClick={() => {
              void api?.workflow.cancelStep({
                stepRunId: StepRunId.make(step.stepRunId),
              });
            }}
          >
            <XIcon className="size-3.5" />
            Cancel
          </Button>
        </div>
      ) : null}
      {isTrustBlockedScriptStep(step) ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="xs"
            disabled={!api || !projectId}
            onClick={() => {
              if (!api || !projectId) {
                return;
              }
              void api.workflow.setProjectScriptTrust({ projectId, trusted: true }).then(onRunLane);
            }}
          >
            <CheckIcon className="size-3.5" />
            Trust this project &amp; run
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Grouped prop shapes used by TicketFullscreen to reduce the call-site surface.
// ---------------------------------------------------------------------------

interface TicketFullscreenEditState {
  readonly draftTitle: string;
  readonly draftDescription: string;
  readonly editError: string | null;
  readonly editSubmitting: boolean;
  readonly setDraftTitle: (value: string) => void;
  readonly setDraftDescription: (value: string) => void;
  readonly saveTicketEdit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly cancelEdit: () => void;
}

interface TicketFullscreenReplyState {
  readonly canReply: boolean;
  readonly replyText: string;
  readonly setReplyText: (value: string) => void;
  readonly replyAttachments: ReadonlyArray<TicketDrawerAttachment>;
  readonly setReplyAttachments: (
    updater: (
      current: ReadonlyArray<TicketDrawerAttachment>,
    ) => ReadonlyArray<TicketDrawerAttachment>,
  ) => void;
  readonly replyError: string | null;
  readonly replySubmitting: boolean;
  readonly onAnswerStep?: ((input: TicketDrawerAnswerInput) => Promise<void>) | undefined;
  readonly onPostComment?: ((input: TicketDrawerCommentInput) => Promise<void>) | undefined;
  readonly attachReplyImages: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  readonly sendReply: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

interface TicketFullscreenApprovalState {
  readonly approvalSubmittingStepRunId: string | null;
  readonly approvalError: { readonly stepRunId: string; readonly message: string } | null;
  readonly submitApproval: (stepRunId: string, approved: boolean) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Full-screen overlay — renders all ticket fields in a spacious multi-column
// layout. Reuses the drawer's inner sub-components and helper functions.
// Composes WorkflowEditorFullscreen for Escape-to-close, body-overflow lock,
// and focus-trap behaviour.
// ---------------------------------------------------------------------------

function TicketFullscreen({
  api,
  detail,
  lanes,
  laneDisplayName,
  laneActions,
  canRunLane,
  runLaneTitle,
  routeHistory,
  latestRouteDecision,
  ticketDescription,
  editState,
  sourceOwned,
  onStartEdit,
  onEditTicket,
  replyState,
  approvalState,
  waitingStepCount,
  projectId,
  cwd,
  onEditMessage,
  onMove,
  onRunLane,
  onClose,
}: {
  readonly api?: EnvironmentApi | undefined;
  readonly detail: TicketDrawerDetail;
  readonly lanes: ReadonlyArray<TicketDrawerLane>;
  readonly laneDisplayName: (key: string) => string;
  readonly laneActions: ReadonlyArray<TicketDrawerLaneAction>;
  readonly canRunLane: boolean;
  readonly runLaneTitle: string;
  readonly routeHistory: ReadonlyArray<RouteDecisionView>;
  readonly latestRouteDecision: ReturnType<typeof describeRouteDecision> | null;
  readonly ticketDescription: string;
  /** Non-null when the user has clicked "Edit ticket" in the drawer before opening fullscreen. */
  readonly editState: TicketFullscreenEditState | null;
  readonly sourceOwned: boolean;
  readonly onStartEdit?: (() => void) | undefined;
  readonly onEditTicket?: ((input: TicketDrawerEditInput) => Promise<void>) | undefined;
  readonly replyState: TicketFullscreenReplyState;
  readonly approvalState: TicketFullscreenApprovalState;
  readonly waitingStepCount: number;
  readonly projectId?: ProjectId | undefined;
  readonly cwd?: string | undefined;
  readonly onEditMessage?: ((messageId: string, body: string) => Promise<void>) | undefined;
  readonly onMove?: ((toLane: string) => void) | undefined;
  readonly onRunLane: () => void;
  readonly onClose: () => void;
}) {
  const ticket = detail.ticket;

  return (
    <WorkflowEditorFullscreen open ariaLabel="Ticket detail" onClose={onClose}>
      {/* Header */}
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0 flex-1">
          {ticket.pr !== undefined ? (
            <TicketPrBadges pr={ticket.pr} rowClassName="mb-1" testIds />
          ) : null}
          <h1 className="text-xl font-semibold text-foreground">{ticket.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>
              {laneDisplayName(ticket.currentLaneKey)} / {formatStatusLabel(ticket.status)}
            </span>
            {ticket.boardId ? (
              <span className="font-mono text-xs opacity-60">board:{ticket.boardId}</span>
            ) : null}
            {detail.syncedSource ? (
              <a
                href={detail.syncedSource.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-sm border border-info/40 bg-info/8 px-1.5 py-0.5 text-[10px] font-medium text-info-foreground underline-offset-2 hover:underline"
                data-testid="ticket-synced-source-badge"
              >
                Synced from {detail.syncedSource.provider} ↗
              </a>
            ) : null}
            {detail.syncedSource?.assignees && detail.syncedSource.assignees.length > 0 ? (
              <span className="text-xs">Assignees: {detail.syncedSource.assignees.join(", ")}</span>
            ) : null}
            {detail.syncedSource?.labels && detail.syncedSource.labels.length > 0 ? (
              <span className="text-xs">Labels: {detail.syncedSource.labels.join(", ")}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {waitingStepCount > 0 ? (
            <Badge variant="warning" size="sm">
              waiting on you
            </Badge>
          ) : null}
          {!sourceOwned && onStartEdit ? (
            <Button size="xs" variant="outline" disabled={!onEditTicket} onClick={onStartEdit}>
              <PencilIcon className="size-3.5" />
              Edit ticket
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Collapse ticket to drawer"
            title="Exit full screen"
            onClick={onClose}
          >
            <Minimize2Icon className="size-3.5" />
          </Button>
        </div>
      </header>

      {/* Body — two-column on wide screens */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row">
        {/* Left column: description, route, discussion, reply */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto border-b border-border/60 p-6 lg:border-b-0 lg:border-r">
          {editState ? (
            <form className="space-y-2" onSubmit={editState.saveTicketEdit}>
              <label className="block space-y-1 text-xs font-medium text-muted-foreground">
                Ticket title
                <Input
                  size="sm"
                  value={editState.draftTitle}
                  disabled={sourceOwned || editState.editSubmitting}
                  onChange={(event) => editState.setDraftTitle(event.currentTarget.value)}
                />
              </label>
              <label className="block space-y-1 text-xs font-medium text-muted-foreground">
                Ticket description
                <Textarea
                  size="sm"
                  value={editState.draftDescription}
                  disabled={sourceOwned || editState.editSubmitting}
                  onChange={(event) => editState.setDraftDescription(event.currentTarget.value)}
                />
              </label>
              {editState.editError ? (
                <p className="text-xs text-destructive-foreground">{editState.editError}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  type="submit"
                  disabled={
                    !editState.draftTitle.trim() || !onEditTicket || editState.editSubmitting
                  }
                >
                  <CheckIcon className="size-3.5" />
                  Save ticket
                </Button>
                <Button
                  size="xs"
                  type="button"
                  variant="outline"
                  disabled={editState.editSubmitting}
                  onClick={editState.cancelEdit}
                >
                  <XIcon className="size-3.5" />
                  Cancel edit
                </Button>
              </div>
            </form>
          ) : (
            <TicketDescriptionView description={ticketDescription} density="spacious" />
          )}

          {latestRouteDecision ? (
            <section
              className="rounded-md border border-info/40 bg-info/5 p-4"
              data-testid="ticket-route-why"
            >
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Why is this ticket here?
              </h2>
              <p className="mt-1 text-sm font-medium text-foreground">
                {latestRouteDecision.title}
              </p>
              {latestRouteDecision.details.length > 0 ? (
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {latestRouteDecision.details.join(" · ")}
                </p>
              ) : null}
              <TicketRouteHistoryDetails
                routeHistory={routeHistory}
                laneDisplayName={laneDisplayName}
                detailsClassName="mt-3"
              />
            </section>
          ) : null}

          {/* Discussion */}
          <TicketDiscussionSection
            messages={detail.messages}
            density="spacious"
            cwd={cwd}
            onEditMessage={onEditMessage}
          />

          {/* Reply / comment composer */}
          {replyState.canReply || replyState.onPostComment ? (
            <TicketReplyComposer
              canReply={replyState.canReply}
              replyText={replyState.replyText}
              setReplyText={replyState.setReplyText}
              replyAttachments={replyState.replyAttachments}
              setReplyAttachments={replyState.setReplyAttachments}
              replyError={replyState.replyError}
              replySubmitting={replyState.replySubmitting}
              onAnswerStep={replyState.onAnswerStep}
              onPostComment={replyState.onPostComment}
              attachReplyImages={replyState.attachReplyImages}
              sendReply={replyState.sendReply}
              cwd={cwd}
              formClassName="p-4"
            />
          ) : null}
        </div>

        {/* Right column: steps, artifacts, diff, move controls */}
        <div className="flex min-h-0 w-full flex-col gap-4 overflow-auto p-6 lg:w-[480px] xl:w-[560px]">
          {/* Steps */}
          <section className="rounded-md border border-border/70 bg-card/35 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-foreground">Steps</h2>
              <span className="text-xs text-muted-foreground">{detail.steps.length}</span>
            </div>
            <ol className="space-y-2">
              {detail.steps.map((step) => (
                <TicketStepRow
                  key={step.stepRunId}
                  step={step}
                  api={api}
                  projectId={projectId}
                  approvalSubmittingStepRunId={approvalState.approvalSubmittingStepRunId}
                  approvalError={approvalState.approvalError}
                  stepOutputTestId="step-captured-output"
                  onRunLane={onRunLane}
                  submitApproval={approvalState.submitApproval}
                  liClassName="p-3"
                />
              ))}
            </ol>
          </section>

          {api ? <TicketArtifacts api={api} ticketId={detail.ticket.ticketId} /> : null}
          {api ? <TicketDiff api={api} ticketId={TicketId.make(detail.ticket.ticketId)} /> : null}

          {/* Lane actions + move controls */}
          <section className="rounded-md border border-border/70 bg-card/35 p-4">
            <h2 className="mb-3 text-sm font-medium text-foreground">Lane controls</h2>
            <div className="space-y-3">
              {onMove && laneActions.length > 0 ? (
                <div className="flex flex-wrap gap-2" data-testid="ticket-lane-actions">
                  {laneActions.map((action) => {
                    const targetLane = lanes.find((lane) => lane.key === action.to);
                    const hint = [action.hint, targetLane ? `Moves to ${targetLane.name}.` : null]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <Button
                        key={`${action.label}:${action.to}`}
                        size="sm"
                        variant="outline"
                        title={hint}
                        onClick={() => onMove(action.to)}
                      >
                        {action.label}
                        {targetLane ? (
                          <span className="text-[11px] font-normal text-muted-foreground">
                            → {targetLane.name}
                          </span>
                        ) : null}
                      </Button>
                    );
                  })}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={!canRunLane} title={runLaneTitle} onClick={onRunLane}>
                  <PlayIcon className="size-4" />
                  Run lane
                </Button>
                {onMove && lanes.length > 0 ? (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Move
                    <select
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                      value={detail.ticket.currentLaneKey}
                      onChange={(event) => onMove(event.currentTarget.value)}
                    >
                      {lanes.map((lane) => (
                        <option key={lane.key} value={lane.key}>
                          {lane.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>
    </WorkflowEditorFullscreen>
  );
}

function formatStatusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function formatMessageTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatStepBadgeLabel(step: TicketDrawerDetail["steps"][number]): string {
  if (step.stepType !== "script") {
    return formatStatusLabel(step.status);
  }

  switch (step.scriptStatus) {
    case "running":
      return "running";
    case "exited":
      return typeof step.exitCode === "number" ? `exit ${step.exitCode}` : "exited";
    case "timeout":
      return "timed out";
    case "cancelled":
      return "cancelled";
    case null:
    case undefined:
      return formatStatusLabel(step.status);
    default:
      return formatStatusLabel(step.scriptStatus);
  }
}

function stepBadgeVariant(step: TicketDrawerDetail["steps"][number]) {
  if (step.status === "awaiting_user" || step.status === "blocked") {
    return "warning";
  }
  if (step.status === "failed" || step.scriptStatus === "timeout") {
    return "error";
  }
  if (step.status === "completed") {
    return "success";
  }
  if (step.scriptStatus === "running" || step.status === "running") {
    return "info";
  }
  return "outline";
}

function isScriptStepWithTerminal(
  step: TicketDrawerDetail["steps"][number],
): step is TicketDrawerDetail["steps"][number] & {
  readonly scriptThreadId: string;
  readonly terminalId: string;
} {
  return (
    step.stepType === "script" &&
    typeof step.scriptThreadId === "string" &&
    step.scriptThreadId.length > 0 &&
    typeof step.terminalId === "string" &&
    step.terminalId.length > 0
  );
}

function isTrustBlockedScriptStep(step: TicketDrawerDetail["steps"][number]): boolean {
  return (
    step.stepType === "script" &&
    step.status === "blocked" &&
    (step.blockedReason ?? "").toLowerCase().includes("not trusted")
  );
}

function isAwaitingUserInputStep(step: TicketDrawerDetail["steps"][number]): boolean {
  return step.status === "awaiting_user" && step.providerResponseKind === "user-input";
}

function isAwaitingApprovalRequestStep(step: TicketDrawerDetail["steps"][number]): boolean {
  return (
    step.status === "awaiting_user" &&
    (step.providerResponseKind === "request" ||
      (step.stepType === "approval" &&
        (step.providerResponseKind === null || step.providerResponseKind === undefined)))
  );
}

function ScriptStepLogViewer({
  api,
  step,
}: {
  readonly api?: EnvironmentApi | undefined;
  readonly step: TicketDrawerDetail["steps"][number] & {
    readonly scriptThreadId: string;
    readonly terminalId: string;
  };
}) {
  const [history, setHistory] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setHistory("");
      setError(null);
      return;
    }

    setHistory("");
    setError(null);
    return api.terminal.attachHistory(
      {
        threadId: ThreadId.make(step.scriptThreadId),
        terminalId: step.terminalId,
      },
      (event) => {
        applyHistoryEvent(event, setHistory, setError);
      },
    );
  }, [api, step.scriptThreadId, step.terminalId]);

  return (
    <section className="mt-2 overflow-hidden rounded-md border border-border/60 bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5">
        <h4 className="text-xs font-medium text-foreground">Script output</h4>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {step.terminalId}
        </span>
      </div>
      {error ? (
        <p className="px-2 py-2 text-xs text-destructive-foreground">{error}</p>
      ) : (
        <pre className="max-h-64 min-h-16 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
          {history || "No output yet."}
        </pre>
      )}
    </section>
  );
}

function applyHistoryEvent(
  event: TerminalHistoryAttachStreamEvent,
  setHistory: (updater: string | ((current: string) => string)) => void,
  setError: (error: string | null) => void,
) {
  switch (event.type) {
    case "snapshot":
      setHistory(event.snapshot.history);
      setError(null);
      return;
    case "output":
      setHistory((current) => `${current}${event.data}`);
      return;
    case "cleared":
      setHistory("");
      return;
    case "error":
      setError(event.message);
      return;
    case "exited":
    case "closed":
    case "activity":
      return;
  }
}
