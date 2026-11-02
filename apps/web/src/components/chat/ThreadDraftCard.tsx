import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  threadDraftCardModel,
  type ThreadDraftCardModel,
  type ThreadDraftItem,
  threadDraftProjectMatch,
} from "@t3tools/client-runtime/thread-draft";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useEnvironmentShellStatus } from "../../state/shell";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { WorkLogRow } from "./WorkLog";

/**
 * An agent's offer of one new thread on another machine. The user reads the whole prompt here and
 * approves it; only then does this client open a draft there, with the user's own session, and
 * nothing runs there until they send it. This environment never reaches the other machine.
 */
export function ThreadDraftCard(props: {
  readonly item: ThreadDraftItem;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId | null;
  readonly canOperate: boolean;
}) {
  const { environments } = useEnvironments();
  const known = environments.map(({ environmentId, label, displayUrl }) => ({
    environmentId,
    label,
    displayUrl,
  }));
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const eligibleIds = useEnvironmentsWithScope(connected, AuthOrchestrationOperateScope);
  const card = threadDraftCardModel(
    props.item,
    known,
    new Set(connected.map((environment) => environment.environmentId)),
    eligibleIds,
  );
  if (!props.canOperate) {
    return (
      <WorkLogRow
        data-v2-item-type="thread_draft"
        icon={<SendIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={`Offered a new thread on ${card.offeredName}`}
      />
    );
  }
  return (
    <PendingThreadDraft
      card={card}
      sourceEnvironmentId={props.sourceEnvironmentId}
      sourceProjectId={props.sourceProjectId}
    />
  );
}

function PendingThreadDraft(props: {
  readonly card: ThreadDraftCardModel;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId | null;
}) {
  const { card } = props;
  const labelId = useId();
  const [picked, setPicked] = useState<EnvironmentId | null>(null);
  // A picked machine that drops out (disconnects, loses access) falls back to the agent's choice.
  const chosen =
    picked !== null && card.eligible.some((machine) => machine.environmentId === picked)
      ? picked
      : card.initialMachine;
  const chosenName = chosen === null ? null : card.nameOf(chosen);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shellStatus = useEnvironmentShellStatus(chosen);
  const projects = useProjects();
  const source =
    projects.find(
      (project) =>
        project.environmentId === props.sourceEnvironmentId && project.id === props.sourceProjectId,
    ) ?? null;
  // Read in the render that enables Approve, once the machine's projects have loaded.
  const match = chosen === null ? null : threadDraftProjectMatch(source, projects, chosen);
  const handleNewThread = useNewThreadHandler();
  const { openScratchProject } = useScratchProject();
  // Each press gets its own token; leaving the view that shows the card cancels it.
  const pressRef = useRef<{ cancelled: boolean } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels a pending open when the card leaves the screen
  useEffect(
    () => () => {
      if (pressRef.current) pressRef.current.cancelled = true;
    },
    [],
  );

  const loaded = shellStatus === "live";
  const canApprove = chosen !== null && loaded && !pending && !card.unreadable;

  /** Opens the draft; returns what to tell the user when it could not, or null. */
  const openDraft = async (
    environmentId: EnvironmentId,
    press: { readonly cancelled: boolean },
  ): Promise<string | null> => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return "This app can't start threads there.";
    }
    let projectRef = match === null ? null : scopeProjectRef(match.environmentId, match.id);
    if (projectRef === null) {
      // Shows its own toast when it fails, or stops quietly when interrupted.
      const scratch = await openScratchProject(environmentId);
      if (scratch === null || press.cancelled) return null;
      projectRef = scopeProjectRef(scratch.environmentId, scratch.id);
    }
    if (press.cancelled) return null;
    const opened = await handleNewThread(projectRef, {
      prompt: card.promptText,
      freshDraft: true,
      environmentSelection: "manual",
      shouldAbandon: () => press.cancelled,
    });
    // Null only when the open was abandoned because the user left.
    if (opened === null) return null;
    toastManager.add({ type: "success", title: `Draft on ${chosenName}. Read it, then send.` });
    return null;
  };

  const approve = async () => {
    if (chosen === null || chosenName === null) return;
    const press = { cancelled: false };
    pressRef.current = press;
    setPending(true);
    setError(null);
    const failure = await openDraft(chosen, press).catch(() => "Could not open the draft.");
    setPending(false);
    if (!press.cancelled) setError(failure);
  };

  return (
    <div
      data-v2-item-type="thread_draft"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <span id={labelId} className="text-sm font-medium text-foreground">
          New thread on
        </span>
        <Select
          value={chosen}
          disabled={pending}
          onValueChange={(next) => {
            if (next !== null) setPicked(next as EnvironmentId);
          }}
        >
          <SelectTrigger aria-labelledby={labelId}>
            <SelectValue>
              {(selected: EnvironmentId | null) =>
                selected === null ? "Choose a machine" : (card.nameOf(selected) ?? selected)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {card.eligible.map(({ environmentId }) => (
              <SelectItem key={environmentId} value={environmentId} hideIndicator>
                {card.nameOf(environmentId) ?? environmentId}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {chosen === null && card.reason !== null ? (
          <p className="text-xs text-muted-foreground">{card.reason}</p>
        ) : null}
      </div>
      <p className="min-w-0 whitespace-pre-wrap wrap-anywhere text-sm text-foreground">
        {card.promptText}
      </p>
      {card.hiddenCharacters > 0 ? (
        <p role="alert" className="text-xs text-warning">
          This prompt had {card.hiddenCharacters} hidden character
          {card.hiddenCharacters === 1 ? "" : "s"}, which T3 Code removed. It may be malicious.
        </p>
      ) : null}
      {card.unreadable ? (
        <p role="alert" className="text-xs text-destructive">
          This prompt has hidden spacing. Ask the agent to send it again.
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 justify-end">
        <Button
          type="button"
          size="sm-multiline"
          disabled={!canApprove}
          onClick={() => void approve()}
        >
          {chosenName === null
            ? "Approve and open"
            : loaded
              ? `Approve and open on ${chosenName}`
              : `Loading ${chosenName}…`}
        </Button>
      </div>
    </div>
  );
}
