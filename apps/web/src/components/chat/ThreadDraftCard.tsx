import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  threadDraftInitialMachine,
  type ThreadDraftItem,
  threadDraftMachineName,
  threadDraftProjectMatch,
} from "@t3tools/client-runtime/thread-draft";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { sanitizeThreadDraftText } from "@t3tools/shared/promptLinks";
import { SendIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useProjects, useThreadShell } from "../../state/entities";
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
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperate: boolean;
}) {
  const { item } = props;
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
  const eligible = known.filter((machine) => eligibleIds.has(machine.environmentId));
  const nameOf = (environmentId: EnvironmentId) => {
    const machine = known.find((candidate) => candidate.environmentId === environmentId);
    return machine === undefined ? null : threadDraftMachineName(machine, known);
  };
  // Re-checked here so what the user reads is what the other machine gets, whatever A sent.
  const prompt = sanitizeThreadDraftText(item.prompt);
  const hint = item.hint === undefined ? undefined : sanitizeThreadDraftText(item.hint);
  const usableHint =
    hint === undefined || hint.malformed || hint.padded || hint.text.length === 0
      ? undefined
      : hint.text;
  const offeredName =
    (item.environmentId === undefined ? null : nameOf(item.environmentId)) ??
    (usableHint === undefined ? "another machine" : `"${usableHint}"`);

  if (!props.canOperate) {
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<SendIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={`Offered a new thread on ${offeredName}`}
      />
    );
  }
  return (
    <PendingThreadDraft
      item={item}
      threadRef={props.threadRef}
      promptText={prompt.text}
      hiddenCharacters={item.hiddenCharacters + prompt.hiddenCharacters}
      unreadable={prompt.malformed || prompt.padded || prompt.text.length === 0}
      initialMachine={threadDraftInitialMachine(
        { ...item, ...(usableHint === undefined ? { hint: undefined } : { hint: usableHint }) },
        known,
        eligibleIds,
      )}
      eligible={eligible}
      nameOf={nameOf}
      reason={unavailableReason(item, usableHint, known, connected, eligibleIds)}
    />
  );
}

/** Why the machine the agent meant cannot be chosen, when the agent meant one. */
function unavailableReason(
  item: ThreadDraftItem,
  hint: string | undefined,
  known: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
  connected: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  eligible: ReadonlySet<EnvironmentId>,
): string | null {
  const named =
    item.environmentId !== undefined
      ? known.find((machine) => machine.environmentId === item.environmentId)
      : hint === undefined
        ? undefined
        : known.filter((machine) => machine.label.trim().toLowerCase() === hint.toLowerCase())
              .length === 1
          ? known.find((machine) => machine.label.trim().toLowerCase() === hint.toLowerCase())
          : undefined;
  if (item.environmentId !== undefined && named === undefined) {
    return `This app does not know ${hint === undefined ? "that machine" : `"${hint}"`}. Add it to open the draft there.`;
  }
  if (named === undefined || eligible.has(named.environmentId)) return null;
  return connected.some((machine) => machine.environmentId === named.environmentId)
    ? `${named.label} can't start threads from this app.`
    : `Connect ${named.label} to open it there.`;
}

function PendingThreadDraft(props: {
  readonly item: ThreadDraftItem;
  readonly threadRef: ScopedThreadRef | null;
  readonly promptText: string;
  readonly hiddenCharacters: number;
  readonly unreadable: boolean;
  readonly initialMachine: EnvironmentId | null;
  readonly eligible: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
  readonly nameOf: (environmentId: EnvironmentId) => string | null;
  readonly reason: string | null;
}) {
  const labelId = useId();
  const [picked, setPicked] = useState<EnvironmentId | null>(null);
  const chosen = picked ?? props.initialMachine;
  const chosenName = chosen === null ? null : props.nameOf(chosen);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shellStatus = useEnvironmentShellStatus(chosen);
  const sourceThread = useThreadShell(props.threadRef);
  const projects = useProjects();
  const source =
    sourceThread === null || props.threadRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === props.threadRef?.environmentId &&
            project.id === sourceThread.projectId,
        ) ?? null);
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
  const canApprove = chosen !== null && loaded && !pending && !props.unreadable;

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
      prompt: props.promptText,
      freshDraft: true,
      environmentSelection: "manual",
      shouldAbandon: () => press.cancelled,
    });
    if (opened === null) return press.cancelled ? null : "Could not open the draft.";
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
    if (press.cancelled) return;
    setPending(false);
    setError(failure);
  };

  return (
    <div
      data-v2-item-type={props.item.type}
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
                selected === null ? "Choose a machine" : (props.nameOf(selected) ?? selected)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {props.eligible.map(({ environmentId }) => (
              <SelectItem key={environmentId} value={environmentId} hideIndicator>
                {props.nameOf(environmentId) ?? environmentId}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {chosen === null && props.reason !== null ? (
          <p className="text-xs text-muted-foreground">{props.reason}</p>
        ) : null}
      </div>
      <pre className="min-w-0 whitespace-pre-wrap wrap-anywhere font-sans text-sm text-foreground">
        {props.promptText}
      </pre>
      {props.hiddenCharacters > 0 ? (
        <p role="alert" className="text-xs text-warning">
          This prompt had {props.hiddenCharacters} hidden character
          {props.hiddenCharacters === 1 ? "" : "s"}, which T3 Code removed. It may be malicious.
        </p>
      ) : null}
      {props.unreadable ? (
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
