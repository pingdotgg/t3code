import { Stack } from "expo-router";

import { AddProjectRepositoryScreen } from "../../../features/projects/AddProjectScreen";

export default function AddProjectRepositoryRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <AddProjectRepositoryScreen />
    </>
  );
}
