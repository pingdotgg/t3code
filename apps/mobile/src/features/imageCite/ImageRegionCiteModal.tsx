import {
  imageRegionBetween,
  imageRegionCitationName,
  isCitableImageRegion,
  type ImageRegion,
} from "@t3tools/client-runtime/image-region-citation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "@t3tools/mobile-markdown-text/links";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { downloadAttachmentForPreview } from "../../lib/attachmentDownload";
import { cropImageRegionAttachment } from "../../lib/imageRegionCrop";
import { loadLocalAttachmentPreview } from "../../lib/localAttachmentPreview";
import type { MediaActionsSource } from "../../lib/mediaActions";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useRefreshAssetUrl } from "../../state/assets";
import { insertComposerDraftImageCitation } from "../../state/use-composer-drafts";

type LocalImage = { readonly uri: string; readonly dispose: () => void };
type Size = { readonly width: number; readonly height: number };

const REGION_BOX_CLASS_NAME = "absolute rounded-[3px] border-2 border-primary bg-primary/10";

/** The cropper reads bytes on the device, so a remote image is downloaded once and shown from there. */
function useLocalImage(source: MediaActionsSource) {
  const refreshAssetUrl = useRefreshAssetUrl(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const resolveUrl = useEffectEvent(() =>
    "uri" in source ? Promise.resolve(normalizeNativeMarkdownUrl(source.uri)) : refreshAssetUrl(),
  );
  const [state, setState] = useState<{ image: LocalImage | null; error: string | null }>({
    image: null,
    error: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    let loaded: LocalImage | null = null;
    void (async (): Promise<LocalImage | null> => {
      if ("attachment" in source) {
        return loadLocalAttachmentPreview(source.attachment, controller.signal);
      }
      const uri = await resolveUrl();
      if (uri === null) throw new Error("Reconnect to this environment and try again.");
      if (/^(file|content|data):/i.test(uri)) return { uri, dispose: () => undefined };
      return downloadAttachmentForPreview({
        url: uri,
        attachment: { name: source.name, mimeType: source.mimeType },
        signal: controller.signal,
      });
    })()
      .then((image) => {
        if (!image) return;
        if (controller.signal.aborted) {
          image.dispose();
          return;
        }
        loaded = image;
        setState({ image, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          image: null,
          error: error instanceof Error ? error.message : "The image could not be loaded.",
        });
      });
    return () => {
      controller.abort();
      loaded?.dispose();
    };
  }, [source]);
  return state;
}

/** Where a contain-fitted image actually appears inside its frame. */
function containedRect(image: Size, frame: Size) {
  const scale = Math.min(frame.width / image.width, frame.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { left: (frame.width - width) / 2, top: (frame.height - height) / 2, width, height };
}

/**
 * Draws a region over the fitted image. The live box moves on the UI thread; only the finished
 * drag reaches React.
 */
function RegionSelector(props: {
  readonly uri: string;
  readonly region: ImageRegion | null;
  readonly onSelect: (region: ImageRegion | null) => void;
}) {
  const [frame, setFrame] = useState<Size | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const fitted = frame && natural ? containedRect(natural, frame) : null;
  const width = fitted?.width ?? 0;
  const height = fitted?.height ?? 0;
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const endX = useSharedValue(0);
  const endY = useSharedValue(0);
  const dragging = useSharedValue(false);
  const { onSelect } = props;
  const finish = useCallback(
    (x0: number, y0: number, x1: number, y1: number) => {
      if (width <= 0 || height <= 0) return;
      const region = imageRegionBetween(
        { x: x0 / width, y: y0 / height },
        { x: x1 / width, y: y1 / height },
      );
      onSelect(isCitableImageRegion(region, { left: 0, top: 0, width, height }) ? region : null);
    },
    [height, onSelect, width],
  );
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .onBegin((event) => {
          const x = Math.min(width, Math.max(0, event.x));
          const y = Math.min(height, Math.max(0, event.y));
          startX.set(x);
          startY.set(y);
          endX.set(x);
          endY.set(y);
          dragging.set(true);
          runOnJS(onSelect)(null);
        })
        .onUpdate((event) => {
          endX.set(Math.min(width, Math.max(0, event.x)));
          endY.set(Math.min(height, Math.max(0, event.y)));
        })
        .onEnd(() => {
          runOnJS(finish)(startX.value, startY.value, endX.value, endY.value);
        })
        .onFinalize(() => {
          dragging.set(false);
        }),
    [dragging, endX, endY, finish, height, onSelect, startX, startY, width],
  );
  const liveBoxStyle = useAnimatedStyle(() => ({
    opacity: dragging.value ? 1 : 0,
    left: Math.min(startX.value, endX.value),
    top: Math.min(startY.value, endY.value),
    width: Math.abs(endX.value - startX.value),
    height: Math.abs(endY.value - startY.value),
  }));

  return (
    <View
      className="flex-1"
      onLayout={(event) =>
        setFrame({
          width: event.nativeEvent.layout.width,
          height: event.nativeEvent.layout.height,
        })
      }
    >
      <Image
        source={{ uri: props.uri }}
        resizeMode="contain"
        accessible={false}
        onLoad={(event) =>
          setNatural({
            width: event.nativeEvent.source.width,
            height: event.nativeEvent.source.height,
          })
        }
        onError={() => setFailed(true)}
        style={StyleSheet.absoluteFill}
      />
      {fitted ? (
        <GestureDetector gesture={gesture}>
          <View
            accessible
            accessibilityLabel="Image. Drag over the part you want to cite."
            style={{
              position: "absolute",
              left: fitted.left,
              top: fitted.top,
              width,
              height,
            }}
          >
            {props.region ? (
              <View
                pointerEvents="none"
                className={REGION_BOX_CLASS_NAME}
                style={{
                  left: props.region.x * width,
                  top: props.region.y * height,
                  width: props.region.width * width,
                  height: props.region.height * height,
                }}
              />
            ) : null}
            <Animated.View
              pointerEvents="none"
              className={REGION_BOX_CLASS_NAME}
              style={liveBoxStyle}
            />
          </View>
        </GestureDetector>
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          {failed ? (
            <Text className="text-center text-white/80">
              This image could not be opened for citing.
            </Text>
          ) : (
            <ActivityIndicator color="#ffffff" />
          )}
        </View>
      )}
    </View>
  );
}

/**
 * Full-screen region selection for one image. Citing crops the region into the thread's draft
 * as an image chip followed by the comment, the same shape the web composer produces.
 */
export function ImageRegionCiteModal(props: {
  readonly source: MediaActionsSource;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { image, error } = useLocalImage(props.source);
  const [region, setRegion] = useState<ImageRegion | null>(null);
  const [comment, setComment] = useState("");
  const [citing, setCiting] = useState(false);
  // The crop is local and brief, so closing waits for it; a finished crop never outlives the modal.
  const close = () => {
    if (!citing) props.onClose();
  };

  const cite = async () => {
    if (!image || !region || citing) return;
    setCiting(true);
    try {
      const attachment = await cropImageRegionAttachment({
        uri: image.uri,
        region,
        name: imageRegionCitationName(props.source.name),
      });
      const draftKey = scopedThreadKey(props.environmentId, props.threadId);
      if (!insertComposerDraftImageCitation(draftKey, attachment, comment)) {
        Alert.alert(
          "Could not add the region",
          "Remove some attachments or context from the draft and try again.",
        );
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      props.onClose();
    } catch (cause) {
      Alert.alert("Could not cite region", cause instanceof Error ? cause.message : "Try again.");
    } finally {
      setCiting(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1 bg-black">
          <View
            className="flex-row items-center justify-between px-3"
            style={{ paddingTop: insets.top + 4 }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              disabled={citing}
              onPress={close}
              className="min-h-11 min-w-11 items-center justify-center"
            >
              <SymbolView name="xmark" size={20} tintColor="#ffffff" type="monochrome" />
            </Pressable>
            <Text className="flex-1 text-center text-base font-t3-semibold text-white">
              {region ? "Add a comment" : "Drag over a region"}
            </Text>
            <View className="min-h-11 min-w-11" />
          </View>
          <View className="flex-1 p-3">
            {image ? (
              <RegionSelector uri={image.uri} region={region} onSelect={setRegion} />
            ) : (
              <View className="flex-1 items-center justify-center gap-3 px-6">
                {error ? (
                  <Text className="text-center text-white/80">{error}</Text>
                ) : (
                  <ActivityIndicator color="#ffffff" />
                )}
              </View>
            )}
          </View>
          <View
            className="flex-row items-end gap-3 border-t border-white/15 bg-black px-4 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            <TextInput
              multiline
              placeholder="Add an optional comment..."
              value={comment}
              onChangeText={setComment}
              editable={!citing}
              className="max-h-32 min-h-11 flex-1 rounded-[20px] bg-white/10 px-4 py-2.5 text-base text-white"
            />
            <ControlPill
              accessibilityLabel="Cite region"
              icon="arrow.up"
              label={citing ? "Citing…" : "Cite"}
              variant="primary"
              disabled={!image || !region || citing}
              onPress={() => void cite()}
            />
          </View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
