import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { AsyncResult } from "effect/unstable/reactivity";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { workspaceFileImageAtom } from "./workspace-file-image-cache";

function ResolvedWorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
}) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fullScreenVisible, setFullScreenVisible] = useState(false);
  const imageSource = useMemo(
    () => ({ uri: props.uri, cache: "force-cache" as const }),
    [props.uri],
  );
  const fullScreenImages = useMemo(() => [imageSource], [imageSource]);

  return (
    <View className="relative flex-1 bg-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open full-screen preview of ${props.accessibilityLabel}`}
        disabled={loadError !== null}
        className="flex-1 p-4 active:bg-subtle-strong"
        onPress={() => setFullScreenVisible(true)}
      >
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
      </Pressable>

      {loadError !== null ? (
        <View className="absolute inset-0 items-center justify-center bg-card px-6">
          <EmptyState title="Image unavailable" detail={loadError} />
        </View>
      ) : null}

      <ImageViewing
        images={fullScreenImages}
        imageIndex={0}
        visible={fullScreenVisible}
        onRequestClose={() => setFullScreenVisible(false)}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </View>
  );
}

function CachedWorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
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
    />
  );
}

export function WorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string | null;
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
    />
  );
}
