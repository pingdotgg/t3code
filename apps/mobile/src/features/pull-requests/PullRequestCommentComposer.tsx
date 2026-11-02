import { useState } from "react";
import { View } from "react-native";
import { AppTextInput as TextInput } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { PullRequestAttachments } from "./PullRequestAttachments";
import type { PullRequestParams } from "./usePullRequestDiff";
import { useReviewAttachmentInsertion } from "./useReviewAttachmentInsertion";

/**
 * One compact field and attached upload/send toolbar for every native review composer. `inline`
 * drops the outer card so a reply can sit inside a comment card, as on desktop.
 */
export function PullRequestCommentComposer({
  params,
  value,
  onChangeText,
  label,
  placeholder,
  editable = true,
  busy = false,
  canSubmit,
  submitLabel,
  showSubmitLabel = false,
  onSubmit,
  onBusyChange,
  autoFocus = false,
  minimumHeight = 80,
  variant = "card",
}: {
  params: PullRequestParams;
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  placeholder: string;
  editable?: boolean;
  busy?: boolean;
  canSubmit: boolean;
  submitLabel: string;
  showSubmitLabel?: boolean;
  onSubmit: () => void;
  onBusyChange?: (busy: boolean) => void;
  autoFocus?: boolean;
  minimumHeight?: number;
  variant?: "card" | "inline";
}) {
  const insertion = useReviewAttachmentInsertion(value, onChangeText);
  const [uploading, setUploading] = useState(false);
  const [height, setHeight] = useState(minimumHeight);
  return (
    <View
      className={
        variant === "inline"
          ? "flex-row items-end border-t border-border-subtle pr-1"
          : "overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card"
      }
    >
      <TextInput
        {...insertion.inputProps}
        accessibilityLabel={label}
        placeholder={placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        multiline
        maxLength={65536}
        value={value}
        onChangeText={onChangeText}
        editable={editable && !busy && !uploading}
        autoFocus={autoFocus}
        onContentSizeChange={(event) => {
          const next = Math.min(
            200,
            Math.max(minimumHeight, Math.ceil(event.nativeEvent.contentSize.height)),
          );
          setHeight((current) => (current === next ? current : next));
        }}
        className={
          variant === "inline"
            ? "min-h-0 flex-1 rounded-none border-0 bg-transparent px-3 py-2.5 text-sm text-foreground"
            : "min-h-0 rounded-none border-0 bg-transparent px-3 py-3 text-base text-foreground"
        }
        style={{ height, textAlignVertical: "top" }}
      />
      <View
        className={
          variant === "inline"
            ? "flex-row items-center"
            : "min-h-12 flex-row items-center gap-2 border-t border-border-subtle px-2 py-1"
        }
      >
        <PullRequestAttachments
          params={params}
          disabled={!editable || busy}
          onBusyChange={(busy) => {
            setUploading(busy);
            onBusyChange?.(busy);
          }}
          onAppend={insertion.insert}
        />
        {variant === "inline" ? null : <View className="flex-1" />}
        <ControlPill
          icon="arrow.up"
          accessibilityLabel={submitLabel}
          label={showSubmitLabel ? submitLabel : undefined}
          variant="primary"
          disabled={!canSubmit || busy || uploading}
          onPress={onSubmit}
        />
      </View>
    </View>
  );
}
