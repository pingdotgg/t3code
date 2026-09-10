import { TextInputWrapper } from "expo-paste-input";
import { AppTextInput as TextInput } from "../../components/AppText";
import { useNativePaste } from "../../lib/useNativePaste";
import { convertPastedImagesToAttachments } from "../../lib/composerImages";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ApprovalRequestId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Alert, View } from "react-native";
import { useEffect, useRef } from "react";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { pickComposerFiles, pickComposerMedia } from "../../lib/composerImages";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useServerConfigs } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  removeComposerDraftAttachment,
  releaseUnusedComposerAttachmentFiles,
} from "../../state/use-composer-drafts";
import {
  changeQuestionAttachmentPreparation,
  questionAttachmentDraftKey,
  questionAttachmentPreparationAtom,
} from "../../state/question-attachments";

export function QuestionAttachments(props: {
  requestId: ApprovalRequestId;
  question: UserInputQuestion;
  questions: ReadonlyArray<UserInputQuestion>;
  disabled: boolean;
  value: string;
  onChangeText: (value: string) => void;
  onInputFocusChange?: ((focused: boolean) => void) | undefined;
}) {
  const { selectedThread } = useThreadSelection();
  const configs = useServerConfigs();
  const drafts = useAtomValue(composerDraftsAtom);
  const scopeKey = JSON.stringify([
    selectedThread?.environmentId,
    selectedThread?.id,
    props.requestId,
    props.question.id,
  ]);
  const pickerScope = useRef<{ key: string; active: boolean } | null>(null);
  useEffect(() => {
    const scope = { key: scopeKey, active: true };
    pickerScope.current = scope;
    return () => {
      scope.active = false;
    };
  }, [scopeKey]);
  const append = (
    key: string,
    attachments: Parameters<typeof appendComposerDraftAttachments>[1],
  ) => {
    if (!selectedThread) return 0;
    const current = appAtomRegistry.get(composerDraftsAtom);
    const otherCount = props.questions.reduce((count, question) => {
      const target = questionAttachmentDraftKey(
        selectedThread.environmentId,
        selectedThread.id,
        props.requestId,
        question.id,
      );
      return target === key ? count : count + (current[target]?.attachments.length ?? 0);
    }, 0);
    return appendComposerDraftAttachments(key, attachments, {
      maxAttachments: Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - otherCount),
    });
  };
  const paste = useNativePaste((uris) => {
    const scope = pickerScope.current;
    if (
      !selectedThread ||
      props.disabled ||
      !configs.get(selectedThread.environmentId)?.environment.capabilities.questionAttachments
    )
      return;
    const key = questionAttachmentDraftKey(
      selectedThread.environmentId,
      selectedThread.id,
      props.requestId,
      props.question.id,
    );
    changeQuestionAttachmentPreparation(key, 1);
    void convertPastedImagesToAttachments({
      uris,
      existingCount: appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.length ?? 0,
    })
      .then(async (images) => {
        if (
          scope?.active &&
          (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0
        ) {
          if (append(key, images) > 0)
            Alert.alert("Could not paste image", "Too many attachments.");
        } else await releaseUnusedComposerAttachmentFiles(images);
      })
      .catch((error) =>
        Alert.alert("Could not paste image", error instanceof Error ? error.message : "Try again."),
      )
      .finally(() => changeQuestionAttachmentPreparation(key, -1));
  });
  if (!selectedThread || props.question.allowCustomAnswer === false) return null;
  const { environmentId, id: threadId } = selectedThread;
  const capabilities = configs.get(environmentId)?.environment.capabilities;
  const canAttach = capabilities?.questionAttachments === true;
  const key = questionAttachmentDraftKey(
    environmentId,
    threadId,
    props.requestId,
    props.question.id,
  );
  const attachments = drafts[key]?.attachments ?? [];
  const pick = async (kind: "media" | "files") => {
    const scope = pickerScope.current;
    changeQuestionAttachmentPreparation(key, 1);
    try {
      const existingCount = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.length ?? 0;
      const result =
        kind === "files"
          ? await pickComposerFiles({
              existingCount,
              maxBytes: capabilities?.fileAttachments?.maxUploadBytes,
            })
          : await pickComposerMedia({
              existingCount,
              maxVideoBytes: capabilities?.fileAttachments?.maxUploadBytes,
            });
      const picked = "files" in result ? result.files : result.attachments;
      // Resolution on another client clears the reservation while the picker is open.
      if (
        !scope?.active ||
        (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) === 0
      ) {
        await releaseUnusedComposerAttachmentFiles(picked);
        return;
      }
      const rejected = append(key, picked);
      if (result.error || rejected > 0)
        Alert.alert("Could not attach file", result.error ?? "Too many attachments.");
    } catch (error) {
      Alert.alert("Could not attach file", error instanceof Error ? error.message : "Try again.");
    } finally {
      changeQuestionAttachmentPreparation(key, -1);
    }
  };
  return (
    <View className="gap-2">
      {canAttach ? (
        <ComposerAttachmentButton
          disabled={props.disabled}
          supportsFiles={Boolean(capabilities?.fileAttachments)}
          onPickMedia={() => pick("media")}
          onPickFiles={() => pick("files")}
        />
      ) : null}
      <ComposerAttachmentStrip
        environmentId={environmentId}
        attachments={attachments}
        onRemove={(id) => {
          if (!props.disabled) removeComposerDraftAttachment(key, id);
        }}
      />
      <TextInputWrapper onPaste={paste}>
        <TextInput
          value={props.value}
          editable={!props.disabled}
          onChangeText={props.onChangeText}
          onFocus={() => props.onInputFocusChange?.(true)}
          onBlur={() => props.onInputFocusChange?.(false)}
          placeholder="Or type a custom answer"
          className="min-h-[54px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
        />
      </TextInputWrapper>
    </View>
  );
}
