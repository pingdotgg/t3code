import { useEffect, useEffectEvent, useState } from "react";
import { StackActions, useIsFocused, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";
import { Button } from "../../components/ui/Button";
import { threadEnvironment } from "../../state/threads";
import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { scopedThreadKey } from "../../lib/scopedEntities";

const dismissedThreadKeys = new Set<string>();

type ThreadSplitSuggestionProps = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
  readonly message: string;
  readonly enabled: boolean;
};

export function ThreadSplitSuggestion(props: ThreadSplitSuggestionProps) {
  const focused = useIsFocused();
  const canSuggest = useAtomValue(
    threadEnvironment.suggestSplit.permissionAtom(props.environmentId),
  );
  const threadKey = scopedThreadKey(props.environmentId, props.threadId);
  const [dismissed, setDismissed] = useState(() => dismissedThreadKeys.has(threadKey));
  const hasMessage = Boolean(props.message.trim());
  if (dismissed && !hasMessage) {
    dismissedThreadKeys.delete(threadKey);
    setDismissed(false);
  }
  if (!props.enabled || !focused || !canSuggest || !hasMessage || dismissed) return null;
  return (
    <ActiveThreadSplitSuggestion
      key={JSON.stringify([props.environmentId, props.threadId, props.message])}
      {...props}
      onDismiss={() => {
        dismissedThreadKeys.add(threadKey);
        setDismissed(true);
      }}
    />
  );
}

function ActiveThreadSplitSuggestion(
  props: ThreadSplitSuggestionProps & { readonly onDismiss: () => void },
) {
  const navigation = useNavigation();
  const [suggestedMessage, setSuggestedMessage] = useState<string | null>(null);
  const suggest = useAtomCommand(threadEnvironment.suggestSplit, {
    reportFailure: false,
    reportDefect: false,
  });
  const request = useEffectEvent(suggest);
  const { environmentId, threadId, message } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounce remote inference and discard responses after the draft or destination changes
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void request({ environmentId, input: { threadId, message } }).then((result) => {
        if (!cancelled)
          setSuggestedMessage(result._tag === "Success" && result.value.suggest ? message : null);
      });
    }, 1_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentId, threadId, message]);

  if (suggestedMessage !== message) return null;

  return (
    <View className="flex-row items-center">
      <Button
        label="Start a new thread with this message"
        tone="text"
        onPress={() => {
          const draft = getComposerDraftSnapshot(props.draftKey);
          if (draft.text !== message || draft.attachments.length > 0 || draft.context) return;
          const draftId = createNewTaskDraft({ environmentId, projectId: props.projectId });
          setComposerDraftText(draftId, message);
          updateComposerDraftSettings(draftId, {
            modelSelection: draft.modelSelection,
            runtimeMode: draft.runtimeMode,
            interactionMode: draft.interactionMode,
            workspaceSelection: draft.workspaceSelection,
          });
          navigation.dispatch(
            StackActions.push("Thread", {
              draft: { draftId, environmentId, projectId: props.projectId },
            }),
          );
          setComposerDraftText(props.draftKey, "");
        }}
      />
      <Button label="Dismiss thread suggestion" tone="text" onPress={props.onDismiss} />
    </View>
  );
}
