import { useAtomValue } from "@effect/atom-react";
import { useId, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";
import { AsyncResult } from "effect/unstable/reactivity";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { workspaceFileImageAtom } from "./workspace-file-image-cache";
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open full-screen preview of ${props.accessibilityLabel}`}
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
      {loadError !== null ? (
        <View className="absolute inset-0 items-center justify-center bg-card px-6">
          <EmptyState title="Image unavailable" detail={loadError} />
        </View>
      ) : null}

      <View className="absolute right-2 top-2">
        <MediaActionsMenu media={mediaActions} />
      </View>

      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}

function CachedWorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
  readonly actionsSource?: MediaActionsSource;
}) {
  const imageAtom = useMemo(() => workspaceFileImageAtom(props.uri), [props.uri]);
  const imageResult = useAtomValue(imageAtom);

  if (AsyncResult.isFailure(imageResult)) {
    return (
      <View className="flex-1 items-center justify-center bg-card px-6">
        <EmptyState
          title="Image unavailable"
          detail="The image could not be loaded into the local cache."
        />
      </View>
    );
  }

  if (!AsyncResult.isSuccess(imageResult)) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-card px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Loading image...</Text>
      </View>
    );
  }

  return (
    <ResolvedWorkspaceFileImagePreview
      accessibilityLabel={props.accessibilityLabel}
      uri={imageResult.value}
      actionsSource={props.actionsSource}
    />
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
    <CachedWorkspaceFileImagePreview
      accessibilityLabel={props.accessibilityLabel}
      uri={props.uri}
      actionsSource={props.actionsSource}
    />
  );
}
