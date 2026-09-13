import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, TaskId } from "@t3tools/contracts";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import {
  partitionTaskMembers,
  taskMemberStatus,
  taskShelf,
} from "@t3tools/client-runtime/state/task-grouping";
import { sortActiveThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  useEnvironmentServerConfig,
  useProjects,
  useThreadShells,
  useServerConfigs,
} from "../../state/entities";
import { environmentShell } from "../../state/shell";
import { useTask } from "../../state/tasks";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";
import { useTaskNavigation } from "./useTaskNavigation";
import { TaskActionsMenu } from "./TaskActionsMenu";
import { TaskMetadataForm } from "./TaskMetadataForm";
import { useTaskActions } from "./useTaskActions";
import { resolveThreadProviderInstance } from "../threads/thread-provider-instance";

function TaskBody({
  task,
  focusName,
}: {
  readonly task: EnvironmentTask;
  readonly focusName?: boolean;
}) {
  const navigation = useNavigation();
  const actions = useTaskActions();
  const navigateTask = useTaskNavigation(task);
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === task.environmentId);
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const pending = usePendingNewTasks().filter(
    (item) => item.environmentId === task.environmentId && item.taskId === task.id,
  );
  const queuedThreadKeys = useAtomValue(queuedThreadKeysAtom);
  const [editedName, setEditedName] = useState<string | null>(null);
  const [editedDescription, setEditedDescription] = useState<string | null>(null);
  const name = editedName ?? task.name;
  const description = editedDescription ?? task.description ?? "";
  const [settledExpanded, setSettledExpanded] = useState(false);
  const members = useMemo(
    () =>
      threads.filter(
        (thread) => thread.environmentId === task.environmentId && thread.taskId === task.id,
      ),
    [threads, task.environmentId, task.id],
  );
  const [, bumpWakeTick] = useState(0);
  const now = new Date().toISOString();
  const nextWake = [task.snoozedUntil, ...members.map((member) => member.snoozedUntil)]
    .flatMap((value) => (value && Date.parse(value) > Date.parse(now) ? [Date.parse(value)] : []))
    .sort((left, right) => left - right)[0];
  const wakeBoundary =
    nextWake === undefined ? undefined : Math.min(nextWake, Date.parse(now) + 2_147_483_646);
  useEffect(() => {
    if (wakeBoundary === undefined) return;
    const timer = setTimeout(
      () => bumpWakeTick((tick) => tick + 1),
      Math.max(0, wakeBoundary - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [wakeBoundary]);
  const groups = partitionTaskMembers(members, { now, queuedThreadKeys });
  const shelf = taskShelf(task, now);
  const openNewThread = () => navigateTask("new-thread");
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 16 }}
    >
      <NativeStackScreenOptions options={{ title: task.name }} />
      <View className="flex-row items-center justify-between">
        <Text className="text-sm text-foreground-muted">
          {groups.live.length} live · {groups.snoozed.length} snoozed · {groups.settled.length}{" "}
          settled
        </Text>
        <TaskActionsMenu
          task={task}
          members={members}
          onRename={() => navigation.setParams({ focusName: true })}
        />
      </View>
      {task.archivedAt !== null ? (
        <>
          <Text className="text-foreground-muted">
            This task is archived. Restore it and its archived members to continue.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void actions.execute("unarchive", task);
            }}
          >
            <Text className="text-primary">Unarchive task and members</Text>
          </Pressable>
        </>
      ) : (
        <>
          {shelf === "settled" || shelf === "snoozed" ? (
            <Text className="text-foreground-muted">
              {shelf === "settled"
                ? "This task is settled. New member activity reopens it."
                : `Snoozed until ${new Date(task.snoozedUntil!).toLocaleString()}. New member activity can wake it.`}
            </Text>
          ) : null}
          <TaskMetadataForm
            focusName={focusName}
            onNameFocused={() => {
              if (focusName) navigation.setParams({ focusName: false });
            }}
            name={name}
            description={description}
            projectId={task.primaryProjectId}
            projects={projects}
            onNameChange={(value) => {
              setEditedName(value);
            }}
            onDescriptionChange={(value) => {
              setEditedDescription(value);
            }}
            onNameSubmit={() => {
              if (editedName !== null && name.trim())
                void actions.update(task, { name: name.trim() }).then((ok) => {
                  if (ok) setEditedName((current) => (current === name ? null : current));
                });
            }}
            onDescriptionSubmit={() => {
              if (editedDescription !== null)
                void actions
                  .update(task, { description: description.trim() || null })
                  .then((ok) => {
                    if (ok)
                      setEditedDescription((current) => (current === description ? null : current));
                  });
            }}
            onProjectChange={(project) => {
              void actions.update(task, { primaryProjectId: project.id });
            }}
            onCancel={() => {
              setEditedName(null);
              setEditedDescription(null);
            }}
          />
          <View className="flex-row gap-4">
            <Pressable
              className="min-h-11 justify-center"
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("ThreadFiles", {
                  environmentId: task.environmentId,
                  taskId: task.id,
                })
              }
            >
              <Text className="text-primary">Files</Text>
            </Pressable>
            <Pressable
              className="min-h-11 justify-center"
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("ThreadTerminal", {
                  environmentId: task.environmentId,
                  taskId: task.id,
                })
              }
            >
              <Text className="text-primary">Terminal</Text>
            </Pressable>
          </View>
          {(["live", "snoozed", "settled"] as const).map((section) => (
            <View key={section} className="gap-2">
              {section === "settled" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: settledExpanded }}
                  onPress={() => setSettledExpanded((value) => !value)}
                >
                  <Text className="text-foreground-muted">
                    {settledExpanded ? "▾" : "▸"} Settled ({groups.settled.length})
                  </Text>
                </Pressable>
              ) : (
                <Text className="text-foreground-muted">
                  {section === "live" ? "Threads" : "Snoozed"}
                </Text>
              )}
              {(section === "settled" && !settledExpanded
                ? []
                : section === "settled"
                  ? [...groups.settled].sort((left, right) =>
                      (right.settledAt ?? right.updatedAt).localeCompare(
                        left.settledAt ?? left.updatedAt,
                      ),
                    )
                  : sortActiveThreadsByOrderKey(groups[section])
              ).map((thread) => {
                const project = projects.find((candidate) => candidate.id === thread.projectId);
                return (
                  <Pressable
                    key={thread.id}
                    accessibilityRole="button"
                    onPress={() =>
                      navigation.navigate("Thread", {
                        environmentId: thread.environmentId,
                        threadId: thread.id,
                      })
                    }
                    className="flex-row items-center gap-3 rounded-xl bg-card px-4 py-3"
                  >
                    {project ? (
                      <ProjectFavicon
                        environmentId={project.environmentId}
                        faviconPath={project.faviconPath}
                        projectTitle={project.title}
                        workspaceRoot={project.workspaceRoot}
                        size={20}
                      />
                    ) : null}
                    <View className="flex-1">
                      <Text numberOfLines={1} className="font-t3-bold text-foreground">
                        {thread.title}
                      </Text>
                      <Text numberOfLines={1} className="text-xs text-foreground-muted">
                        {taskMemberStatus(thread)}
                        {resolveThreadProviderInstance(serverConfigs, thread)?.displayName
                          ? ` · ${resolveThreadProviderInstance(serverConfigs, thread)!.displayName}`
                          : ""}
                        {thread.branch ? ` · ${thread.branch}` : ""}
                        {thread.pullRequests?.length ? ` · ${thread.pullRequests.length} PR` : ""}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
              {section === "live" ? (
                <>
                  {pending.map((item) => (
                    <Pressable
                      key={item.key}
                      accessibilityRole="button"
                      onPress={() =>
                        navigation.navigate("NewTaskSheet", {
                          screen: "NewTaskDraft",
                          params: {
                            environmentId: item.environmentId,
                            projectId: item.projectId,
                            taskId: task.id,
                            ...(item.kind === "draft"
                              ? { draftId: item.draftKey }
                              : { pendingTaskId: item.message.messageId }),
                          },
                        })
                      }
                      className="rounded-xl bg-card px-4 py-3"
                    >
                      <Text className="text-foreground">{item.title}</Text>
                      <Text className="text-xs text-foreground-muted">
                        {item.kind === "draft" ? "Draft" : "Queued"}
                      </Text>
                    </Pressable>
                  ))}
                </>
              ) : null}
              {section === "snoozed" ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={openNewThread}
                  className="min-h-11 justify-center"
                >
                  <Text className="text-primary">＋ New thread</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}

function TaskHomeButton() {
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityLabel="Go to tasks and threads"
      accessibilityRole="button"
      onPress={() => navigation.dispatch(StackActions.replace("Home"))}
      className="min-h-11 justify-center px-2"
    >
      <Text className="text-primary">Home</Text>
    </Pressable>
  );
}

export function TaskRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly taskId: string;
  readonly focusName?: boolean;
}>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const taskId = TaskId.make(route.params.taskId);
  const task = useTask({ environmentId, taskId });
  const config = useEnvironmentServerConfig(environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const archiveIds = useMemo(() => (task === null ? [environmentId] : []), [environmentId, task]);
  const archive = useArchivedThreadSnapshots(archiveIds);
  const archived = archive.snapshots
    .flatMap((entry) =>
      (entry.snapshot.tasks ?? []).map((record) => ({
        ...record,
        environmentId: entry.environmentId,
      })),
    )
    .find((record) => record.id === taskId && record.environmentId === environmentId);
  const resolved = task ?? archived;
  const content = (() => {
    if (config && config.environment.capabilities.tasks !== true)
      return (
        <View className="flex-1 items-center justify-center bg-screen p-6">
          <Text>Tasks are not supported by this environment.</Text>
        </View>
      );
    if (resolved)
      return (
        <>
          <NativeStackScreenOptions options={{ title: resolved.name }} />
          {shell.status !== "live" ? (
            <Text className="bg-card px-4 py-2 text-foreground-muted">
              Showing saved task. Reconnect to update it.
            </Text>
          ) : null}
          <TaskBody
            key={`${environmentId}:${taskId}`}
            task={resolved}
            focusName={route.params.focusName}
          />
        </>
      );
    return (
      <View className="flex-1 items-center justify-center bg-screen p-6">
        <Text>
          {shell.status === "empty" || shell.status === "synchronizing" || archive.isLoading
            ? "Loading task…"
            : shell.status !== "live"
              ? "Reconnect to load this task."
              : archive.error
                ? "Could not load archived tasks. Try again when connected."
                : "This task no longer exists."}
        </Text>
      </View>
    );
  })();
  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: resolved?.name ?? "Task",
          headerLeft: navigation.canGoBack() ? undefined : TaskHomeButton,
        }}
      />
      {content}
    </>
  );
}
