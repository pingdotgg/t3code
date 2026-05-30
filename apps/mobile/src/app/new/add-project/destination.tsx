import { Stack } from "expo-router";

import { AddProjectDestinationScreen } from "../../../features/projects/AddProjectScreen";

export default function AddProjectDestinationRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <AddProjectDestinationScreen />
    </>
  );
}
