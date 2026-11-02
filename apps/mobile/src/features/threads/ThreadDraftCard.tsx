import { useIsFocused } from "@react-navigation/native";
import { StackActions } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  threadDraftCardModel,
  type ThreadDraftCardModel,
  threadDraftProjectMatch,
} from "@t3tools/client-runtime/thread-draft";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { useEnvironmentShellReadiness } from "../../state/shell";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";

const SEND_SYMBOL: AppSymbolName = { ios: "paperplane", android: "desktop_windows" };

/**
 * An agent's offer of one new thread on another machine. The user reads the whole prompt here and
 * approves it; only then does this app open a draft there, with the user's own session, and
 * nothing runs there until they send it. The agent's machine never reaches the other one.
 */
export function ThreadDraftCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props.projectedItem;
  const { environments } = useEnvironments();
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const known = useMemo(
    () =>
      environments.map(({ environmentId, label, displayUrl }) => ({
        environmentId,
        label,
        displayUrl,
      })),
    [environments],
  );
  const connected = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );
  const eligibleIds = useEnvironmentsWithScope(connected, AuthOrchestrationOperateScope);
  if (item.type !== "thread_draft") return null;
  const card = threadDraftCardModel(
    item,
    known,
    new Set(connected.map((environment) => environment.environmentId)),
    eligibleIds,
  );
  if (!canOperate) {
    return (
      <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
        <SymbolView name={SEND_SYMBOL} size={13} tintColor={props.iconColor} type="monochrome" />
        <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
          Offered a new thread on {card.offeredName}
        </Text>
      </View>
    );
  }
  return (
    <PendingThreadDraft
      sourceEnvironmentId={props.environmentId}
      threadId={item.threadId}
      card={card}
    />
  );
}

function PendingThreadDraft(props: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly threadId: OrchestrationV2ProjectedTurnItem["item"]["threadId"];
  readonly card: ThreadDraftCardModel;
}) {
  const { card } = props;
  const [picked, setPicked] = useState<EnvironmentId | null>(null);
  // A picked machine that drops out (disconnects, loses access) falls back to the agent's choice.
  const chosen =
    picked !== null && card.eligible.some((machine) => machine.environmentId === picked)
      ? picked
      : card.initialMachine;
  const chosenName = chosen === null ? null : card.nameOf(chosen);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readiness = useEnvironmentShellReadiness(chosen);
  const sourceThread = useThreadShell({
    environmentId: props.sourceEnvironmentId,
    threadId: props.threadId,
  });
  const projects = useProjects();
  const source =
    sourceThread === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === props.sourceEnvironmentId &&
            project.id === sourceThread.projectId,
        ) ?? null);
  // Read in the render that enables Approve, once the machine's projects have loaded.
  const match = chosen === null ? null : threadDraftProjectMatch(source, projects, chosen);
  // Inactive stack screens stay mounted, so focus loss cancels a pending press too.
  const focused = useIsFocused();
  const pressRef = useRef<{ cancelled: boolean } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels a pending open when the screen loses focus or the card unmounts
  useEffect(() => {
    if (!focused && pressRef.current) pressRef.current.cancelled = true;
    return () => {
      if (pressRef.current) pressRef.current.cancelled = true;
    };
  }, [focused]);

  const loaded = readiness.status === "live";
  const canApprove = chosen !== null && loaded && !pending && !card.unreadable;

  /** Opens the draft; returns what to tell the user when it could not, or null. */
  const openDraft = async (
    environmentId: EnvironmentId,
    press: { readonly cancelled: boolean },
  ): Promise<string | null> => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return "This app can't start threads there.";
    }
    let project = match;
    if (project === null) {
      const scratch = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.openScratch,
        { environmentId, input: {} },
        { reportFailure: false },
      );
      if (press.cancelled) return null;
      if (scratch._tag === "Failure") {
        if (isAtomCommandInterrupted(scratch)) return null;
        const cause = squashAtomCommandFailure(scratch);
        return cause instanceof Error ? cause.message : "Could not open the draft.";
      }
      project = scratch.value;
    }
    const loaded = await waitForComposerDraftsLoaded().then(
      () => true,
      () => false,
    );
    if (!loaded) return "Drafts could not be loaded.";
    if (press.cancelled) return null;
    // Always a fresh draft on the chosen machine and project; mobile drafts keep their machine.
    const draftKey = createNewTaskDraft({
      environmentId: project.environmentId,
      projectId: project.id,
    });
    setComposerDraftText(draftKey, card.promptText);
    rootNavigationRef.dispatch(
      StackActions.push("Thread", { draft: { draftId: draftKey, title: project.title } }),
    );
    return null;
  };

  const approve = async () => {
    if (chosen === null || chosenName === null) return;
    const press = { cancelled: false };
    pressRef.current = press;
    setPending(true);
    setError(null);
    const failure = await openDraft(chosen, press).catch(() => "Could not open the draft.");
    // Focus loss cancels the press but keeps the card mounted, so pending always ends.
    setPending(false);
    if (!press.cancelled) setError(failure);
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-2">
        <Text className="font-t3-bold text-base text-foreground">New thread on</Text>
        {card.eligible.length === 0 ? (
          <Text className="font-sans text-sm text-foreground-muted">
            This app can't start threads on any connected machine.
          </Text>
        ) : (
          card.eligible.map(({ environmentId }) => {
            const selected = environmentId === chosen;
            return (
              <Pressable
                key={environmentId}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled: pending }}
                disabled={pending}
                onPress={() => setPicked(environmentId)}
                className="rounded-xl border border-border px-3 py-2 active:opacity-60"
              >
                <Text
                  className={
                    selected
                      ? "font-t3-medium text-sm text-foreground"
                      : "font-sans text-sm text-foreground-muted"
                  }
                >
                  {selected ? "● " : "○ "}
                  {card.nameOf(environmentId) ?? environmentId}
                </Text>
              </Pressable>
            );
          })
        )}
        {chosen === null && card.reason !== null ? (
          <Text className="font-sans text-xs text-foreground-muted">{card.reason}</Text>
        ) : null}
      </View>
      <Text className="font-sans text-sm leading-5 text-foreground" selectable>
        {card.promptText}
      </Text>
      {card.hiddenCharacters > 0 ? (
        <Text accessibilityRole="alert" className="font-sans text-xs text-warning-foreground">
          This prompt had {card.hiddenCharacters} hidden character
          {card.hiddenCharacters === 1 ? "" : "s"}, which T3 Code removed. It may be malicious.
        </Text>
      ) : null}
      {card.unreadable ? (
        <Text accessibilityRole="alert" className="font-sans text-xs text-danger-foreground">
          This prompt has hidden spacing. Ask the agent to send it again.
        </Text>
      ) : null}
      {error !== null ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label={
          chosenName === null
            ? "Choose a machine"
            : loaded
              ? `Approve and open on ${chosenName}`
              : `Loading ${chosenName}…`
        }
        tone="primary"
        fullWidth
        loading={pending}
        disabled={!canApprove}
        onPress={() => void approve()}
      />
    </View>
  );
}
