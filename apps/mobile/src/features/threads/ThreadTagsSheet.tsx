import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { AppTextInput, AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { failureMessage } from "../../lib/failureMessage";
import { appAtomRegistry } from "../../state/atom-registry";
import { useQuietThreadShell, useQuietThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  collectThreadTags,
  validateThreadTag,
} from "@t3tools/client-runtime/state/threadTagFilter";
import { threadTagPickerRows } from "./thread-tags";

interface ThreadTagsTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const threadTagsTargetAtom = Atom.make<ThreadTagsTarget | null>(null).pipe(Atom.keepAlive);

export function openThreadTagsSheet(thread: EnvironmentThreadShell) {
  appAtomRegistry.set(threadTagsTargetAtom, {
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
}

export function ThreadTagsHost() {
  const target = useAtomValue(threadTagsTargetAtom);
  return target ? (
    <ThreadTagsSheet
      key={`${target.environmentId}:${target.threadId}`}
      target={target}
      onClose={() => appAtomRegistry.set(threadTagsTargetAtom, null)}
    />
  ) : null;
}

function ThreadTagsSheet(props: {
  readonly target: ThreadTagsTarget;
  readonly onClose: () => void;
}) {
  const thread = useQuietThreadShell(
    scopeThreadRef(props.target.environmentId, props.target.threadId),
  );
  const shells = useQuietThreadShells();
  const setTag = useAtomCommand(threadEnvironment.setTag, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const own = thread?.tags ?? [];
  const known = collectThreadTags(
    shells.filter((shell) => shell.environmentId === props.target.environmentId),
  );
  const rows = threadTagPickerRows(known, own, draft);
  const trimmed = draft.trim();
  const canCreate =
    trimmed !== "" &&
    ![...known, ...own].some((tag) => tag.toLowerCase() === trimmed.toLowerCase());

  const apply = async (tag: string, tagged: boolean) => {
    const result = await setTag({
      environmentId: props.target.environmentId,
      input: { threadId: props.target.threadId, tag, tagged },
    });
    if (result._tag === "Success") return true;
    Dialog.alert(
      "Could not update tags",
      failureMessage(result.cause, "The tag could not be changed."),
    );
    return false;
  };

  const create = async () => {
    const existing = known.find(
      (tag) => tag.toLowerCase() === trimmed.toLowerCase() && !own.includes(tag),
    );
    if (existing !== undefined) {
      setError(null);
      setDraft("");
      await apply(existing, true);
      return;
    }
    if (!canCreate) return;
    const validated = validateThreadTag(draft, own);
    if (validated.kind === "error") {
      setError(validated.message);
      return;
    }
    if (validated.kind === "empty") return;
    setError(null);
    setDraft("");
    await apply(validated.tag, true);
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaProvider style={{ flex: 1 }}>
        <View className="flex-1 bg-sheet">
          <SafeAreaView style={{ flex: 1 }}>
            <SheetHeader
              presentation="inline"
              title="Tags"
              subtitle={thread?.title}
              onClose={props.onClose}
              accessibilityLabel="Close tags"
            />
            <KeyboardAvoidingView behavior="padding" className="flex-1">
              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerClassName="gap-4 px-5 pb-6 pt-2"
              >
                <View className="gap-2">
                  <AppTextInput
                    autoFocus
                    accessibilityLabel="Search or create a tag"
                    value={draft}
                    onChangeText={(text) => {
                      setDraft(text);
                      setError(null);
                    }}
                    onSubmitEditing={() => void create()}
                    placeholder="Search or create a tag"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                  />
                  {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
                </View>
                <View>
                  {rows.map((tag, index) => (
                    <SelectionRow
                      key={tag}
                      title={tag}
                      role="checkbox"
                      selected={own.includes(tag)}
                      isFirst={index === 0}
                      isLast={index === rows.length - 1 && !canCreate}
                      onPress={() => void apply(tag, !own.includes(tag))}
                    />
                  ))}
                  {canCreate ? (
                    <NavigationRow
                      className="bg-grouped-card"
                      title={`Create tag "${trimmed}"`}
                      leading={
                        <SymbolView name="plus" size={20} tintColorClassName="accent-icon-muted" />
                      }
                      accessibilityRole="button"
                      onPress={() => void create()}
                    />
                  ) : null}
                </View>
              </ScrollView>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}
