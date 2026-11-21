import {
  startableOrbitProject,
  type OrbitGatewayProject,
} from "@t3tools/client-runtime/orbit-gateway";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { orbitGatewayClient } from "./orbitGatewayClient";
import { useOrbitReservation } from "./orbitReservations";
import { startOrbitThread } from "./orbitThreadStartRuntime";
import { orbitStartReturn } from "./orbitThreadStarts";

/**
 * Conn: starts a thread in an Orbit Project. Orbit creates a clone of the Project's default
 * Instance, and the thread starts there with the first message (FORK.md, "Orbit").
 */
export function OrbitThreadStartScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<readonly OrbitGatewayProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [text, setText] = useState("");
  const started = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Gateway's Projects once when the screen opens
  useEffect(() => {
    let current = true;
    orbitGatewayClient.projects().then(
      (list) => current && setProjects(list.flatMap((row) => startableOrbitProject(row) ?? [])),
      (error: unknown) =>
        current && setLoadError(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, []);

  const project = projects?.find((entry) => entry.id === chosenId) ?? projects?.[0] ?? null;
  // Conn: a clone of the chosen Project is reserved while this screen shows (invisible pre-warm).
  useOrbitReservation(project?.id ?? null, true);
  const canStart = project !== null && text.trim() !== "";
  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.getParent()?.goBack();
  };
  const start = () => {
    if (started.current || project === null || text.trim() === "") return;
    started.current = true;
    const { back, returnRouteKey } = orbitStartReturn(navigation.getState());
    startOrbitThread(project, text.trim(), returnRouteKey);
    navigation.dispatch(StackActions.pop(back));
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar title="Orbit project" hideBottomBorder onBack={goBack} />
      <ScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: 20,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: 8,
          }}
        >
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Orbit creates a clone of the project's default instance, and the thread starts there
            with this message.
          </Text>
          {loadError ? <ErrorBanner message={loadError} /> : null}
          <ListSection title="Project">
            {projects === null ? (
              loadError ? null : (
                <View className="items-center p-4">
                  <AppActivityIndicator colorClassName="accent-icon-muted" />
                </View>
              )
            ) : projects.length === 0 ? (
              <Text className="p-4 text-sm leading-normal text-foreground-muted">
                No Orbit project has a default instance in a container that this device reaches.
              </Text>
            ) : (
              projects.map((entry, index) => (
                <ListChoiceRow
                  key={entry.id}
                  label={entry.name}
                  description={entry.nodeName}
                  selected={entry.id === project?.id}
                  separated={index > 0}
                  onPress={() => setChosenId(entry.id)}
                />
              ))
            )}
          </ListSection>
          <ListSection title="First message">
            <TextInput
              accessibilityLabel="First message"
              value={text}
              onChangeText={setText}
              multiline
              scrollEnabled
              textAlignVertical="top"
              placeholder="What should the agent do?"
              placeholderTextColorClassName="accent-foreground-muted"
              className="max-h-48 min-h-28 p-4 font-sans text-base text-foreground"
            />
          </ListSection>
          <Button
            label="Start thread"
            tone="primary"
            fullWidth
            disabled={!canStart}
            onPress={start}
          />
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
