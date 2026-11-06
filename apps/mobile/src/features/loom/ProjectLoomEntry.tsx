import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";

export function ProjectLoomEntry(props: { readonly projects: ReadonlyArray<EnvironmentProject> }) {
  const navigation = useNavigation();
  const { savedConnectionsById } = useSavedRemoteConnections();
  if (props.projects.length === 0) return null;
  return (
    <View className="self-start px-4 py-2">
      <ListFilterMenu
        label="Loom"
        accessibilityLabel="Open project Loom"
        actions={props.projects.map((project) => ({
          id: JSON.stringify([project.environmentId, project.id]),
          title: project.title,
          subtitle:
            savedConnectionsById[project.environmentId]?.environmentLabel ?? project.environmentId,
        }))}
        onSelect={(id) => {
          const project = props.projects.find(
            (candidate) => JSON.stringify([candidate.environmentId, candidate.id]) === id,
          );
          if (project)
            navigation.navigate("ProjectLoom", {
              environmentId: project.environmentId,
              projectId: project.id,
            });
        }}
      />
    </View>
  );
}
