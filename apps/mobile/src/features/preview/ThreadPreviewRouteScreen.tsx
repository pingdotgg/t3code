import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { Platform, View } from "react-native";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { ThreadPreviewPane } from "./ThreadPreviewPane";

type ThreadPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function ThreadPreviewRouteScreen(props: ThreadPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const { previewPane, previewPaneFullscreen, setPreviewPaneFullscreen, showAuxiliaryPane } =
    useAdaptiveWorkspaceLayout();
  const revealedInspectorRef = useRef(false);
  const environmentIdRaw = firstRouteParam(props.route.params.environmentId);
  const threadIdRaw = firstRouteParam(props.route.params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = threadIdRaw ? ThreadId.make(threadIdRaw) : null;

  useEffect(() => {
    if (previewPane.supported && !revealedInspectorRef.current) {
      revealedInspectorRef.current = true;
      showAuxiliaryPane("preview");
    }
  }, [previewPane.supported, showAuxiliaryPane]);

  const handleReturnToThread = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (environmentId && threadId) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
    }
  }, [environmentId, navigation, threadId]);

  const renderInspector = useCallback(
    (headerInset: number) =>
      environmentId && threadId ? (
        <ThreadPreviewPane
          environmentId={environmentId}
          threadId={threadId}
          headerInset={headerInset}
          presentation="inspector"
          fullscreen={previewPaneFullscreen}
          onFullscreenChange={setPreviewPaneFullscreen}
        />
      ) : null,
    [environmentId, previewPaneFullscreen, setPreviewPaneFullscreen, threadId],
  );

  if (!environmentId || !threadId) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState
          variant="plain"
          title="Browser unavailable"
          detail="This thread browser link is invalid."
        />
      </View>
    );
  }

  if (previewPane.supported) {
    return (
      <ThreadRouteScreen
        auxiliaryRoute="browser"
        onReturnToThread={handleReturnToThread}
        renderInspector={renderInspector}
        route={props.route}
      />
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: "Browser",
          headerTitle: "Browser",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Browser" onBack={handleReturnToThread} />
      ) : null}
      <ThreadPreviewPane
        environmentId={environmentId}
        threadId={threadId}
        presentation="screen"
        onAttachmentAdded={handleReturnToThread}
      />
    </View>
  );
}
