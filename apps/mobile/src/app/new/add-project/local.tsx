import { Stack } from "expo-router";

import { AddProjectLocalFolderScreen } from "../../../features/projects/AddProjectScreen";

export default function AddProjectLocalRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <AddProjectLocalFolderScreen />
    </>
  );
}
