import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  normalizeThreadNote,
  THREAD_NOTE_MAX_LENGTH,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type ThreadNoteSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

const COUNTER_THRESHOLD = THREAD_NOTE_MAX_LENGTH - 1_000;

export function ThreadNoteSheet({ route }: ThreadNoteSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const ref = scopeThreadRef(route.params.environmentId, route.params.threadId);
  const note = useAtomValue(environmentThreadDetails.quietThreadAtom(ref))?.projection.thread.note;
  const setThreadNote = useAtomCommand(threadEnvironment.setNote, "save thread note");
  const [draft, setDraft] = useState(note ?? "");

  const save = () => {
    navigation.goBack();
    const next = normalizeThreadNote(draft);
    if (next === normalizeThreadNote(note ?? null)) return;
    void setThreadNote({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, note: next },
    });
  };

  const android = Platform.OS === "android";
  return (
    // Android renders content first and reverses the column, as GitCommitSheet explains.
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1 android:flex-col-reverse"
      style={android ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="automatic"
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerClassName="px-5 pt-4 gap-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <TextInput
            multiline
            autoFocus
            accessibilityLabel="Thread note"
            value={draft}
            onChangeText={setDraft}
            maxLength={THREAD_NOTE_MAX_LENGTH}
            placeholder="Add a note for this thread…"
            textAlignVertical="top"
            className="min-h-40 rounded-xl bg-subtle px-4 py-3 text-base"
          />
          <View className="flex-row justify-between gap-2">
            <Text className="text-xs text-foreground-muted">
              Only visible to you. Not sent to the agent.
            </Text>
            {draft.length > COUNTER_THRESHOLD ? (
              <Text className="text-xs text-foreground-muted">
                {draft.length.toLocaleString()} / {THREAD_NOTE_MAX_LENGTH.toLocaleString()}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </ScreenContent>
      <SheetHeader
        title="Note"
        onCancel={() => navigation.goBack()}
        confirm={{ label: "Done", onPress: save }}
      />
    </View>
  );
}
