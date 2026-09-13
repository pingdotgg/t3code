import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { useEnvironments } from "../../state/environments";

export function TaskMetadataForm(props: {
  readonly name: string;
  readonly description: string;
  readonly projectId: ProjectId | null;
  readonly environmentId?: EnvironmentId;
  readonly projects: readonly EnvironmentProject[];
  readonly onNameChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onProjectChange: (project: EnvironmentProject) => void;
  readonly onNameSubmit?: () => void;
  readonly onDescriptionSubmit?: () => void;
  readonly onCancel?: () => void;
}) {
  const { environments } = useEnvironments();
  const showEnvironment = new Set(props.projects.map((project) => project.environmentId)).size > 1;
  const projectLabel = (project: EnvironmentProject) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === project.environmentId,
    );
    return showEnvironment && environment
      ? `${project.title} · ${environment.label}`
      : project.title;
  };
  const selected = props.projects.find(
    (project) =>
      project.id === props.projectId &&
      (props.environmentId === undefined || project.environmentId === props.environmentId),
  );
  return (
    <View className="gap-3">
      <TextInput
        accessibilityLabel="Task name"
        placeholder="Task name"
        value={props.name}
        onChangeText={props.onNameChange}
        onBlur={props.onNameSubmit}
        onSubmitEditing={props.onNameSubmit}
        onKeyPress={({ nativeEvent }) => {
          if (nativeEvent.key === "Escape") props.onCancel?.();
        }}
        className="rounded-xl bg-input px-4 py-3 text-xl font-t3-bold text-foreground"
      />
      <TextInput
        accessibilityLabel="Task description"
        placeholder="Description (optional)"
        multiline
        value={props.description}
        onChangeText={props.onDescriptionChange}
        onBlur={props.onDescriptionSubmit}
        onKeyPress={({ nativeEvent }) => {
          if (nativeEvent.key === "Escape") props.onCancel?.();
        }}
        className="min-h-20 rounded-xl bg-input px-4 py-3 text-base text-foreground"
      />
      <ControlPillMenu
        actions={props.projects.map((project) => ({
          id: `${project.environmentId}:${project.id}`,
          title: projectLabel(project),
          state: project === selected ? "on" : "off",
        }))}
        onPressAction={({ nativeEvent: { event } }) => {
          const project = props.projects.find(
            (candidate) => `${candidate.environmentId}:${candidate.id}` === event,
          );
          if (project) props.onProjectChange(project);
        }}
      >
        <Pressable
          accessibilityLabel="Primary project"
          accessibilityRole="button"
          className="min-h-11 justify-center rounded-xl bg-card px-4"
        >
          <Text className="text-base text-foreground">
            {selected ? projectLabel(selected) : "Choose primary project"}
          </Text>
        </Pressable>
      </ControlPillMenu>
      <Text className="text-xs text-foreground-muted">
        Files and new terminals use the primary project. Threads keep their own checkout.
      </Text>
    </View>
  );
}
