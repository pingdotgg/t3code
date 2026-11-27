import { useMessageTimeFormatter } from "../threads/useMessageTimeFormatter";
import {
  requestedQueueAtom,
  selectedQueueAtom,
  type QueueScope,
} from "../../state/mergeQueueSelection";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  type StaticScreenProps,
  StackActions,
  useFocusEffect,
  useNavigation,
} from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectMergeQueue,
  ProjectMergeQueuesResult,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react-native";
import { checkStatus } from "./pullRequestStatus";
import { useCallback, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";

const queueStateLabels = {
  queued: msg("waiting"),
  "awaiting-checks": msg("awaiting checks"),
  mergeable: msg("ready to merge"),
  unmergeable: msg("cannot merge"),
  locked: msg("locked"),
} as const;

function QueueEntry({
  entry,
  project,
  environmentId,
  refresh,
}: {
  entry: ProjectMergeQueue["entries"][number];
  project: ProjectMergeQueuesResult[number];
  environmentId: EnvironmentId;
  refresh: () => void;
}) {
  const gt = useGT();
  const formatTime = useMessageTimeFormatter();
  const resolve = useMessages();
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const writable = useAtomValue(composerPullRequests.runAction.permissionAtom(environmentId));
  const run = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const reference = {
    projectId: project.projectId,
    host: project.host,
    repository: project.repository,
    number: entry.number,
  };
  const remove = () =>
    Dialog.confirm({
      title: gt("Remove {repository} #{number} from the merge queue?", reference),
      confirmText: gt("Remove from queue"),
      destructive: true,
      onConfirm: async () => {
        setBusy(true);
        const result = await run({
          environmentId,
          input: { ...reference, action: "disable-auto-merge" },
        });
        setBusy(false);
        if (result._tag === "Failure")
          Dialog.alert(gt("Could not remove from queue"), String(squashAtomCommandFailure(result)));
        refresh();
      },
    });
  return (
    <View className="gap-2 border-b border-border px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="gap-1"
      >
        <Text className="text-xs text-foreground-muted">
          {gt("Position {position}", { position: entry.position })} ·{" "}
          {resolve(queueStateLabels[entry.state])}
        </Text>
        <Text className="font-t3-bold">
          #{entry.number} {entry.title}
        </Text>
        {entry.enqueuedAt && (
          <Text className="text-xs text-foreground-muted">
            {gt("Enqueued {time}", { time: formatTime(entry.enqueuedAt) })}
          </Text>
        )}
        <Text className="text-xs text-foreground-muted">
          {entry.estimatedMergeAt
            ? gt("Estimated merge {time}", {
                time: formatTime(entry.estimatedMergeAt),
              })
            : gt("Merge estimate unavailable")}
        </Text>
      </Pressable>
      {expanded && (
        <View className="gap-2">
          <Text className="font-t3-bold">{gt("Merge group checks")}</Text>
          {entry.checks?.length ? (
            entry.checks.map((check) => (
              <Text
                key={JSON.stringify([check.name, check.url])}
                onPress={check.url ? () => void tryOpenExternalUrl(check.url!) : undefined}
              >
                {check.name} · {checkStatus(check, resolve).label}
                {check.required ? " · " + gt("Required") : ""}
              </Text>
            ))
          ) : (
            <Text>
              {entry.checks ? gt("No checks reported") : gt("Merge group checks unavailable")}
            </Text>
          )}
          <Button
            label={gt("Open pull request")}
            size="compact"
            onPress={() =>
              navigation.dispatch(StackActions.push("PullRequest", { environmentId, ...reference }))
            }
          />
        </View>
      )}
      {writable && (
        <Button
          label={gt("Remove from queue")}
          tone="text"
          size="compact"
          disabled={busy}
          onPress={remove}
        />
      )}
    </View>
  );
}

const emptySelection = Atom.make<QueueScope | null>(null);

function EnvironmentQueues({
  id,
  label,
  scope,
  picker,
}: {
  id: EnvironmentId;
  label: string;
  scope?: QueueScope | undefined;
  picker?: boolean | undefined;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const selected = useAtomValue(picker ? selectedQueueAtom : emptySelection);
  const choose = useAtomSet(requestedQueueAtom);
  const { data, error, refresh, isPending } = useEnvironmentQuery(
    composerPullRequests.mergeQueues({ environmentId: id, input: {} }),
  );
  useFocusEffect(
    useCallback(() => {
      refresh();
      const timer = setInterval(() => {
        if (AppState.currentState === "active") refresh();
      }, 60000);
      return () => clearInterval(timer);
    }, [refresh]),
  );
  const projects = data?.filter(
    (project) =>
      (!scope ||
        (project.repository.toLowerCase() === scope.repository.toLowerCase() &&
          (!scope.host || project.host === scope.host))) &&
      (project.queues === null ||
        project.queues.some((queue) => !scope || queue.branch === scope.branch)),
  );
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between">
        <Text className="font-t3-bold">{label}</Text>
        <Button label={gt("Refresh")} size="compact" disabled={isPending} onPress={refresh} />
      </View>
      {error ? (
        <Text>{error}</Text>
      ) : !projects ? (
        <Text>{gt("Loading merge queues…")}</Text>
      ) : projects.length === 0 ? (
        <Text>
          {scope
            ? gt("No merge queue found for {repository} ({branch}).", {
                repository: scope.repository,
                branch: scope.branch,
              })
            : gt("No merge queues found for these projects.")}
        </Text>
      ) : (
        projects.map((project) => (
          <View key={project.projectId}>
            <Text className="font-t3-bold">{project.repository}</Text>
            {project.queues === null ? (
              <Text>{gt("Could not read this repository’s merge queues.")}</Text>
            ) : (
              project.queues
                .filter((queue) => !scope || queue.branch === scope.branch)
                .map((queue) =>
                  picker ? (
                    <Pressable
                      key={queue.branch}
                      accessibilityRole="button"
                      accessibilityLabel={project.repository + " " + queue.branch}
                      accessibilityState={{
                        selected:
                          selected?.environmentId === id &&
                          selected.repository === project.repository &&
                          selected.host === project.host &&
                          selected.branch === queue.branch,
                      }}
                      className="my-1 flex-row items-center justify-between rounded-lg bg-subtle px-3 py-3"
                      onPress={() => {
                        choose({
                          environmentId: id,
                          repository: project.repository,
                          host: project.host,
                          branch: queue.branch,
                        });
                        navigation.navigate("MergeQueueEntries");
                      }}
                    >
                      <Text>{queue.branch}</Text>
                      <Text className="text-foreground-muted">{queue.entries.length}</Text>
                    </Pressable>
                  ) : (
                    <View key={queue.branch}>
                      <Text className="text-sm text-foreground-muted">{queue.branch}</Text>
                      {queue.entries.length === 0 ? (
                        <Text>{gt("Queue is empty")}</Text>
                      ) : (
                        queue.entries.map((entry) => (
                          <QueueEntry
                            key={entry.number}
                            entry={entry}
                            project={project}
                            environmentId={id}
                            refresh={refresh}
                          />
                        ))
                      )}
                    </View>
                  ),
                )
            )}
          </View>
        ))
      )}
    </View>
  );
}

export function MergeQueuesScreen({ route }: StaticScreenProps<QueueScope | undefined>) {
  const gt = useGT();
  const navigation = useNavigation();
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={gt("Merge queues")} onBack={() => navigation.goBack()} />
      <QueueList scope={route.params?.environmentId ? route.params : undefined} />
    </View>
  );
}

export function MergeQueuePicker() {
  return <QueueList picker />;
}

export function MergeQueueEntriesScreen() {
  const selected = useAtomValue(selectedQueueAtom);
  const navigation = useNavigation();
  const gt = useGT();
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={gt("Queued pull requests")} onBack={() => navigation.goBack()} />
      {selected ? (
        <QueueList scope={selected} />
      ) : (
        <Text className="p-4 text-foreground-muted">
          {gt("Select a merge queue to see its pull requests.")}
        </Text>
      )}
    </View>
  );
}

function QueueList({ scope, picker }: { scope?: QueueScope | undefined; picker?: boolean }) {
  const gt = useGT();
  const environments = useWorkspaceEnvironments().filter(
    (env) => env.isEnabled && (!scope || env.environmentId === scope.environmentId),
  );
  return (
    <View className="flex-1 bg-screen">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-4 py-4"
      >
        {environments.length === 0 && <Text>{gt("No connected environments")}</Text>}
        {environments.map((env) =>
          env.connectionState === "connected" ? (
            <EnvironmentQueues
              key={env.environmentId}
              id={env.environmentId}
              label={env.environmentLabel}
              scope={scope}
              picker={picker}
            />
          ) : (
            <Text key={env.environmentId}>
              {env.environmentLabel} · {gt("Disconnected")}
            </Text>
          ),
        )}
      </ScreenScrollView>
    </View>
  );
}
