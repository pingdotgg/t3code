import { useState } from "react";
import { View } from "react-native";
import { AppTextInput as TextInput } from "../../components/ui/AppText";
import { PullRequestAttachments } from "./PullRequestAttachments";
import type { PullRequestParams } from "./usePullRequestDiff";
import { useReviewAttachmentInsertion } from "./useReviewAttachmentInsertion";

/** Desktop's comment form: a plain field with the attachment control beneath; buttons live in the sheet footer. */
export function PullRequestCommentForm({
  params,
  value,
  onChangeText,
  label,
  placeholder,
  editable = true,
  busy = false,
  onBusyChange,
  autoFocus = false,
  minimumHeight = 88,
}: {
  params: PullRequestParams;
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  placeholder: string;
  editable?: boolean;
  busy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  autoFocus?: boolean;
  minimumHeight?: number;
}) {
  const insertion = useReviewAttachmentInsertion(value, onChangeText);
  const [uploading, setUploading] = useState(false);
  const [height, setHeight] = useState(minimumHeight);
  return (
    <View className="gap-1">
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
            220,
            Math.max(minimumHeight, Math.ceil(event.nativeEvent.contentSize.height)),
          );
          setHeight((current) => (current === next ? current : next));
        }}
        className="rounded-xl border border-border-subtle bg-grouped-card px-3 py-3 text-base text-foreground"
        style={{ height, textAlignVertical: "top" }}
      />
      <View className="flex-row items-center">
        <PullRequestAttachments
          params={params}
          disabled={!editable || busy}
          onBusyChange={(busy) => {
            setUploading(busy);
            onBusyChange?.(busy);
          }}
          onAppend={insertion.insert}
        />
      </View>
    </View>
  );
}
