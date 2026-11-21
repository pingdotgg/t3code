import {
  modelCameraStatus,
  type ModelCameraView,
} from "@t3tools/client-runtime/model-preview/annotations";
import type { EnvironmentId } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import {
  retryComposerAttachmentUpload,
  useComposerAttachmentUploadState,
} from "../../state/composer-attachment-uploads";
import type { modelAnnotationDrafts } from "../files/modelAnnotationDraft";
import { ModelAnnotationScreenshotPreview } from "../files/ModelAnnotationScreenshotPreview";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";

type ModelAnnotationDraft = ReturnType<typeof modelAnnotationDrafts>[number];

/** Notes on a 3D model waiting in the composer: their screenshot, each note, and a way back. */
export function ModelAnnotationDraftCard(props: {
  readonly draft: ModelAnnotationDraft;
  readonly screenshot: DraftComposerAttachment | undefined;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onRemove: () => void;
  readonly onOpenView: ((path: string, view: ModelCameraView) => void) | undefined;
}) {
  const gt = useGT();
  const { draft, screenshot, environmentId } = props;
  const [previewOpen, setPreviewOpen] = useState(false);
  const upload = useComposerAttachmentUploadState(environmentId, screenshot?.id ?? "");
  // An attachment has no workspace path, so there is no view to reopen.
  const target = draft.target;
  const status = target ? modelCameraStatus(target.view) : null;
  const screenshotUri =
    screenshot?.type === "image" ? (screenshot.dataUrl ?? screenshot.previewUri) : undefined;
  const name = draft.record.pageTitle ?? draft.record.label;
  return (
    <View className="gap-2.5 rounded-2xl border border-border bg-card p-2.5">
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={gt("Preview {name}", { name })}
          disabled={!screenshotUri || props.disabled}
          onPress={() => setPreviewOpen(true)}
        >
          <View className="h-16 w-24 overflow-hidden rounded-lg bg-grouped-card">
            <Image
              source={screenshotUri ? { uri: screenshotUri } : null}
              style={{ width: 96, height: 64 }}
              contentFit="contain"
            />
          </View>
        </Pressable>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text
            className="text-xs text-foreground-muted"
            style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
            numberOfLines={1}
          >
            {[
              gt("{count, plural, one {1 note} other {# notes}}", { count: draft.notes.length }),
              status
                ? gt("az {azimuth}° el {elevation}°", {
                    $context: "3D camera azimuth and elevation, abbreviated",
                    azimuth: status.azimuth,
                    elevation: status.elevation,
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Remove {name}", { name })}
          disabled={props.disabled}
          hitSlop={8}
          onPress={props.onRemove}
          className="size-8 items-center justify-center"
        >
          <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      <View className="gap-1 px-1">
        {draft.notes.map((note) => (
          <Text key={note.number} className="text-sm text-foreground" numberOfLines={2}>
            <Text className="text-sm font-t3-bold text-primary-text">{note.number} </Text>
            {note.text}
          </Text>
        ))}
      </View>
      {(screenshot && upload?.status === "failed") || (props.onOpenView && target) ? (
        <View className="flex-row justify-end gap-2">
          {screenshot && upload?.status === "failed" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Retry uploading {name}", { name: screenshot.name })}
              accessibilityHint={upload.reason}
              disabled={props.disabled}
              onPress={() => retryComposerAttachmentUpload(environmentId, screenshot.id)}
              className="h-8 flex-row items-center gap-1.5 rounded-full border border-border px-3"
            >
              <SymbolView name="arrow.clockwise" size={13} tintColorClassName="accent-icon" />
              <Text className="text-xs font-t3-bold text-foreground">{gt("Retry")}</Text>
            </Pressable>
          ) : null}
          {props.onOpenView && target ? (
            <Pressable
              accessibilityRole="button"
              disabled={props.disabled}
              onPress={() => props.onOpenView?.(target.path, target.view)}
              className="h-8 flex-row items-center gap-1.5 rounded-full border border-border px-3"
            >
              <SymbolView name="cube" size={13} tintColorClassName="accent-icon" />
              <Text className="text-xs font-t3-bold text-foreground">{gt("Open view")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {previewOpen && screenshotUri ? (
        <ModelAnnotationScreenshotPreview
          uri={screenshotUri}
          name={name}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </View>
  );
}
