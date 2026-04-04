import type { OrchestrationThread } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { memo } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cx } from "../../lib/classNames";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { RemoteClientConnectionState } from "../../lib/remoteClient";

function ComposerAction(props: {
  readonly icon:
    | "photo.on.rectangle"
    | "doc.on.clipboard"
    | "arrow.clockwise"
    | "stop.fill"
    | "tray.and.arrow.down.fill"
    | "paperplane.fill";
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly iconTintColor: string;
  readonly backgroundClassName: string;
}) {
  return (
    <Pressable
      className={`items-center justify-center ${props.backgroundClassName} rounded-[16px] px-3 py-3`}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColor={props.iconTintColor}
        type="monochrome"
        weight="medium"
      />
    </Pressable>
  );
}

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly placeholder: string;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly selectedThread: OrchestrationThread;
  readonly queueCount: number;
  readonly activeThreadBusy: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onPasteIntoDraft: () => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onStopThread: () => Promise<void>;
  readonly onSendMessage: () => void;
}

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const canSend =
    props.connectionState === "ready" &&
    (props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0);
  const showStopAction =
    props.selectedThread.session?.status === "running" ||
    props.selectedThread.session?.status === "starting" ||
    props.queueCount > 0;

  return (
    <View
      className="gap-3 border-t border-slate-200 bg-white/92 px-4 pt-3.5 dark:border-white/6 dark:bg-slate-950/92"
      style={{ paddingBottom: (props.bottomInset ?? 0) + 16 }}
    >
      <View className="rounded-[24px] border border-slate-200 bg-white px-3.5 py-3 dark:border-white/8 dark:bg-slate-900">
        <TextInput
          multiline
          value={props.draftMessage}
          onChangeText={props.onChangeDraftMessage}
          placeholder={props.placeholder}
          className="max-h-[180px] min-h-[92px] px-1 py-1 font-sans text-[15px] leading-[22px] text-slate-950 dark:text-slate-50"
          editable={props.connectionState === "ready"}
          textAlignVertical="top"
        />
        <View className="mt-3 flex-row flex-wrap items-center justify-between gap-2.5">
          <View className="flex-row flex-wrap gap-2.5">
            <ComposerAction
              icon="photo.on.rectangle"
              backgroundClassName="bg-slate-200 dark:bg-slate-800"
              iconTintColor="#0f172a"
              onPress={() => void props.onPickDraftImages()}
            />
            <ComposerAction
              icon="doc.on.clipboard"
              backgroundClassName="bg-slate-200 dark:bg-slate-800"
              iconTintColor="#0f172a"
              onPress={() => void props.onPasteIntoDraft()}
            />
            <ComposerAction
              icon="arrow.clockwise"
              backgroundClassName="bg-slate-200 dark:bg-slate-800"
              iconTintColor="#0f172a"
              onPress={() => void props.onRefresh()}
            />
          </View>
          <View className="flex-row flex-wrap gap-2.5">
            {showStopAction ? (
              <ComposerAction
                icon="stop.fill"
                backgroundClassName="bg-rose-100 dark:bg-rose-500/18"
                iconTintColor="#be123c"
                onPress={() => void props.onStopThread()}
              />
            ) : null}
            <ComposerAction
              icon={
                props.activeThreadBusy || props.queueCount > 0
                  ? "tray.and.arrow.down.fill"
                  : "paperplane.fill"
              }
              backgroundClassName={cx(
                canSend ? "bg-orange-500" : "bg-slate-200 dark:bg-slate-700/60",
              )}
              iconTintColor="#ffffff"
              disabled={!canSend}
              onPress={props.onSendMessage}
            />
          </View>
        </View>
      </View>
      {props.draftAttachments.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-2">
            {props.draftAttachments.map((image) => (
              <View key={image.id} className="gap-2">
                <Image
                  source={{ uri: image.previewUri }}
                  className="h-[84px] w-[84px] rounded-[18px] bg-slate-200 dark:bg-slate-800"
                  resizeMode="cover"
                />
                <Pressable
                  className="items-center rounded-[12px] bg-slate-200 px-2.5 py-2 dark:bg-slate-800"
                  onPress={() => props.onRemoveDraftImage(image.id)}
                >
                  <Text className="font-t3-bold text-xs text-slate-950 dark:text-slate-50">
                    Remove
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        </ScrollView>
      ) : null}
      {props.queueCount > 0 ? (
        <Text className="font-t3-medium text-xs leading-[18px] text-slate-500 dark:text-slate-400">
          {props.queueCount} queued message{props.queueCount === 1 ? "" : "s"} will send
          automatically.
        </Text>
      ) : null}
    </View>
  );
});
