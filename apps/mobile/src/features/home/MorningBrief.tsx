import { useAtomValue } from "@effect/atom-react";
import {
  type BriefLine,
  briefLineCount,
  buildMorningBrief,
  formatBriefSince,
  morningBriefIsEmpty,
  morningBriefSummary,
} from "@cz/client-runtime/decisions/morningBrief";
import type { EnvironmentId } from "@cz/contracts";
import { useNavigation } from "@react-navigation/native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import {
  decisionEnvironment,
  useFilteredOpenDecisions,
  useMachineBriefs,
} from "../../state/decisions";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { fleetAtom } from "../../state/fleet";
import { useJobsOn } from "../../state/jobs";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadListActions } from "./useThreadListActions";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The Morning brief at the top of the phone's feed: what happened on every
 * machine since the owner last looked. Opening the app marks it seen, so
 * the next brief starts from this visit.
 */
export function MorningBrief() {
  const navigation = useNavigation();
  const [now] = useState(Date.now);
  const { entries } = useFilteredOpenDecisions();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const jobs = useJobsOn(environmentIds);
  const machines = useMachineBriefs(environmentIds);
  const fleet = useAtomValue(fleetAtom);
  const [folded, setFolded] = useState(false);
  const brief = useMemo(
    () => buildMorningBrief({ machines, decisions: entries, threads, jobs, fleet }),
    [machines, entries, threads, jobs, fleet],
  );
  const markSeen = useAtomCommand(decisionEnvironment.briefSeen, { reportFailure: false });
  useEffect(() => {
    const seen = () => {
      for (const environmentId of environmentIds) {
        void markSeen({ environmentId, input: undefined });
      }
    };
    seen();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") seen();
    });
    return () => subscription.remove();
  }, [environmentIds, markSeen]);

  if (morningBriefIsEmpty(brief)) return null;
  const openThread = (environmentId: string, threadId: string) =>
    navigation.navigate("Thread", { environmentId, threadId });

  if (folded) {
    return (
      <Pressable
        className="mx-4 mb-2 flex-row gap-2 rounded-xl border border-border px-4 py-3"
        onPress={() => setFolded(false)}
      >
        <Text className="font-cz-medium text-sm text-foreground">Morning brief</Text>
        <Text className="flex-1 text-sm text-foreground-muted" numberOfLines={1}>
          {morningBriefSummary(brief)}
        </Text>
      </Pressable>
    );
  }

  const top = brief.decisions.top;
  return (
    <View className="mx-4 mb-2 gap-4 rounded-xl border border-border bg-subtle p-4">
      <View className="flex-row items-center gap-2">
        <Text className="font-cz-medium text-base text-foreground">Morning brief</Text>
        <Text className="flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {brief.since === null
            ? ""
            : `since you last looked, ${formatBriefSince(brief.since, now)}`}
          {brief.writing ? " · writing…" : ""}
        </Text>
        <Pressable onPress={() => setFolded(true)} hitSlop={8}>
          <Text className="text-sm text-primary">Fold</Text>
        </Pressable>
      </View>

      {brief.done.length > 0 ? (
        <BriefSection title="Done">
          {brief.done.map((line) => (
            <BriefLineRow key={line.key} line={line} onOpenThread={openThread} />
          ))}
        </BriefSection>
      ) : null}

      {brief.failed.length > 0 ? (
        <BriefSection title="Failed or stopped">
          {brief.failed.map((line) => (
            <BriefLineRow key={line.key} line={line} onOpenThread={openThread} />
          ))}
        </BriefSection>
      ) : null}

      {top !== null || brief.waiting.length > 0 ? (
        <BriefSection title="Needs you">
          {top ? (
            <Pressable
              onPress={() =>
                navigation.navigate("Decision", {
                  environmentId: top.environmentId,
                  id: top.item.id,
                })
              }
            >
              <Text className="text-sm text-foreground">
                <Text className="font-cz-medium">{plural(brief.decisions.total, "Decision")}</Text>
                <Text className="text-foreground-muted">
                  {": "}
                  {brief.decisions.byProject
                    .map(({ project, count }) => `${count} ${project}`)
                    .join(", ")}
                </Text>
              </Text>
            </Pressable>
          ) : null}
          {brief.waiting.map((thread) => (
            <Pressable
              key={`${thread.environmentId}:${thread.id}`}
              onPress={() => openThread(String(thread.environmentId), thread.id)}
            >
              <Text className="text-sm text-foreground" numberOfLines={2}>
                {thread.title}
                <Text className="text-foreground-muted">
                  {thread.hasPendingApprovals ? " is waiting for approval" : " asked you something"}
                </Text>
              </Text>
            </Pressable>
          ))}
        </BriefSection>
      ) : null}

      {brief.machines.length > 0 ? (
        <BriefSection title="Machines">
          {brief.machines.map((machine) => (
            <Pressable key={machine.environmentId} onPress={() => navigation.navigate("Fleet")}>
              <Text className="text-sm text-foreground">
                <Text className="font-cz-medium">{machine.label}</Text>
                <Text className="text-foreground-muted"> {machine.problem}</Text>
              </Text>
            </Pressable>
          ))}
        </BriefSection>
      ) : null}
    </View>
  );
}

function BriefSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Text className="text-xs font-cz-medium uppercase tracking-wide text-foreground-muted">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** One thread opens it; several expand in place. Failed and stopped lines carry one action. */
function BriefLineRow({
  line,
  onOpenThread,
}: {
  readonly line: BriefLine;
  readonly onOpenThread: (environmentId: string, threadId: string) => void;
}) {
  const navigation = useNavigation();
  const [open, setOpen] = useState(false);
  const retry = useAtomCommand(decisionEnvironment.retryThreads, "retry threads");
  const { archiveThread } = useThreadListActions();
  const shells = useThreadShells();
  const single = line.threads.length === 1 && line.jobs.length === 0 ? line.threads[0] : null;

  const onPress = () => {
    if (single) onOpenThread(String(single.environmentId), single.threadId);
    else if (line.threads.length === 0)
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsSchedules" },
      });
    else setOpen((current) => !current);
  };
  const onRetry = () => {
    const byMachine = new Map<EnvironmentId, string[]>();
    for (const thread of line.threads) {
      byMachine.set(thread.environmentId, [
        ...(byMachine.get(thread.environmentId) ?? []),
        thread.threadId,
      ]);
    }
    for (const [environmentId, threadIds] of byMachine) {
      void retry({ environmentId, input: { threadIds } });
    }
  };
  const onDismiss = () => {
    for (const ref of line.threads) {
      const shell = shells.find(
        (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
      );
      if (shell) archiveThread(shell);
    }
  };

  return (
    <View className="gap-1">
      <View className="flex-row items-start gap-2">
        <Pressable className="flex-1" onPress={onPress}>
          <Text className="text-sm text-foreground">
            <Text className="font-cz-medium">{line.label}</Text>
            <Text className="text-foreground-muted">: </Text>
            {line.text}
            {single || line.threads.length === 0 ? null : (
              <Text className="text-foreground-muted">
                {" "}
                · {briefLineCount(line)} {open ? "▾" : "▸"}
              </Text>
            )}
          </Text>
        </Pressable>
        {line.action === "open" || line.threads.length === 0 ? null : (
          <Pressable
            className="rounded-lg border border-border px-2.5 py-1"
            hitSlop={6}
            onPress={line.action === "retry" ? onRetry : onDismiss}
          >
            <Text className="text-xs text-foreground">
              {line.action === "retry" ? "Retry" : "Dismiss"}
            </Text>
          </Pressable>
        )}
      </View>
      {open && !single ? (
        <View className="ml-2 gap-1.5 border-l border-border pl-3">
          {line.threads.map((thread) => (
            <Pressable
              key={`${thread.environmentId}:${thread.threadId}`}
              onPress={() => onOpenThread(String(thread.environmentId), thread.threadId)}
            >
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {thread.title}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
