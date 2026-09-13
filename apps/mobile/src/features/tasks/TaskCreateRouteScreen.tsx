import { useNavigation, StackActions, type StaticScreenProps } from "@react-navigation/native";
import { TaskId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { Alert, Pressable, ScrollView } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useProjects, useServerConfigs } from "../../state/entities";
import { taskEnvironment } from "../../state/tasks";
import { useAtomCommand } from "../../state/use-atom-command";
import { TaskMetadataForm } from "./TaskMetadataForm";
import {
  resolveTaskCreateProject,
  taskCreateCommand,
  taskCreateProjects,
  type TaskCreateContext,
} from "./taskCreateContext";

export function TaskCreateRouteScreen({ route }: StaticScreenProps<TaskCreateContext | undefined>) {
  const navigation = useNavigation();
  const allProjects = useProjects();
  const configs = useServerConfigs();
  const projects = taskCreateProjects({
    projects: allProjects,
    capableIds: new Set(
      [...configs].flatMap(([id, config]) =>
        config.environment.capabilities.tasks === true ? [id] : [],
      ),
    ),
    context: route.params,
  });
  const [selection, setSelection] = useState<{
    environmentId: EnvironmentId;
    projectId: ProjectId;
  } | null>(null);
  const selected = resolveTaskCreateProject({ projects, selection, context: route.params });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const create = useAtomCommand(taskEnvironment.create, { reportFailure: false });
  async function submit() {
    if (busy) return;
    const taskId = TaskId.make(randomUUID());
    const command = taskCreateCommand({
      projects,
      selection,
      context: route.params,
      taskId,
      name,
      description,
    });
    if (command === null) return;
    setBusy(true);
    try {
      const result = await create(command);
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not create task",
          error instanceof Error ? error.message : String(error),
        );
      } else
        navigation.dispatch(
          StackActions.replace("Task", { environmentId: command.environmentId, taskId }),
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 20 }}
    >
      <TaskMetadataForm
        name={name}
        description={description}
        projectId={selected?.id ?? null}
        environmentId={selected?.environmentId}
        projects={projects}
        onNameChange={setName}
        onDescriptionChange={setDescription}
        onProjectChange={(project) =>
          setSelection({ environmentId: project.environmentId, projectId: project.id })
        }
      />
      {projects.length === 0 ? (
        <Text className="text-foreground-muted">
          Connect to an environment that supports Tasks and add a project first.
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={!name.trim() || !selected || busy}
        onPress={() => {
          void submit();
        }}
        className="min-h-12 items-center justify-center rounded-xl bg-primary disabled:opacity-40"
      >
        <Text className="font-t3-bold text-primary-foreground">
          {busy ? "Creating…" : "Create task"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
