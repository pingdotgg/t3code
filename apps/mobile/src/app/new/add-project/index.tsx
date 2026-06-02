import { Stack } from "expo-router";

import { AddProjectSourceScreen } from "../../../features/projects/AddProjectScreen";

export default function AddProjectRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <AddProjectSourceScreen />
    </>
  );
}
