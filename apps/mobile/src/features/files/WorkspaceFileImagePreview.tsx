import { useId, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { PresentationSource } from "../../components/NativePresentation";
import { useMediaActions, type MediaActionsSource } from "../../lib/mediaActions";
import { MediaActionsMenu } from "../../components/MediaActionsMenu";

function ResolvedWorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
  readonly actionsSource?: MediaActionsSource;
}) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const sourceIdentifier = useId();
  const mediaActions = useMediaActions(props.actionsSource);
  const imageSource = useMemo(
    () => ({ uri: props.uri, cache: "force-cache" as const }),
    [props.uri],
  );

  return (
    <View className="relative flex-1 bg-subtle">
      <MediaActionsMenu media={mediaActions} style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open full-screen preview of ${props.accessibilityLabel}`}
          accessibilityHint={
            mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
          }
          disabled={loadError !== null}
          className="flex-1 p-4 active:bg-subtle-strong"
          onPress={() =>
            setPreview({
              kind: "image",
              uri: props.uri,
              name: props.accessibilityLabel,
              sourceIdentifier,
              actionsSource: props.actionsSource,
            })
          }
        >
          <PresentationSource identifier={sourceIdentifier} style={{ flex: 1 }}>
            <Image
              accessible={false}
              source={imageSource}
              className="h-full w-full"
              resizeMode="contain"
              onLoadStart={() => setLoadError(null)}
              onError={(event) => {
                setLoadError(event.nativeEvent.error || "The image could not be rendered.");
              }}
            />
          </PresentationSource>
        </Pressable>
      </MediaActionsMenu>
      {loadError !== null ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 items-center justify-center bg-card px-6"
        >
          <EmptyState title="Image unavailable" detail={loadError} />
        </View>
      ) : null}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}

export function WorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string | null;
  readonly actionsSource?: MediaActionsSource;
}) {
  if (props.uri === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-card px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">
          Preparing image preview...
        </Text>
      </View>
    );
  }

  return (
    <ResolvedWorkspaceFileImagePreview
      accessibilityLabel={props.accessibilityLabel}
      uri={props.uri}
      actionsSource={props.actionsSource}
    />
  );
}
