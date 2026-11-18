import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useMemo, useRef, useState } from "react";
import { Modal, Pressable, type TextInputInstance, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SearchField } from "../../components/ui/SearchField";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { scopedThreadKey } from "../../lib/scopedEntities";

export interface AttachToThreadSheetProps {
  readonly thread: EnvironmentThreadShell | null;
  readonly candidates: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectTitleOf: (thread: EnvironmentThreadShell) => string | null;
  readonly onPick: (target: EnvironmentThreadShell) => void;
  readonly onClose: () => void;
}

function AttachToThreadBody(props: Omit<AttachToThreadSheetProps, "thread">) {
  const { candidates, onClose, onPick, projectTitleOf } = props;
  const inputRef = useRef<TextInputInstance | null>(null);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle === ""
        ? candidates
        : candidates.filter((candidate) => candidate.title.toLowerCase().includes(needle)),
    [candidates, needle],
  );
  return (
    <View className="flex-1 bg-screen">
      <SafeAreaView style={{ flex: 1 }}>
        <SheetHeader
          presentation="inline"
          title="Attach to thread"
          onClose={onClose}
          accessibilityLabel="Close attach to thread"
        />
        <View className="flex-row px-5 pb-3">
          <SearchField
            inputRef={inputRef}
            autoFocus={false}
            accessibilityLabel="Search threads"
            clearAccessibilityLabel="Clear search"
            placeholder="Search threads"
            value={query}
            onChangeText={setQuery}
          />
        </View>
        {visible.length === 0 ? (
          <Text className="px-5 py-6 text-base text-foreground-muted">No threads to attach to</Text>
        ) : (
          // oxlint-disable-next-line t3code/require-registered-list-scroll -- A full-screen Modal with an inline header; there is no navigation header to register with.
          <LegendList
            data={visible}
            keyboardShouldPersistTaps="handled"
            extraData={projectTitleOf}
            keyExtractor={(candidate) => scopedThreadKey(candidate.environmentId, candidate.id)}
            renderItem={({ item }) => {
              const projectTitle = projectTitleOf(item);
              return (
                <Pressable
                  accessibilityRole="button"
                  className="border-b border-border-subtle px-5 py-3"
                  onPress={() => {
                    onPick(item);
                    onClose();
                  }}
                >
                  <Text numberOfLines={1} className="text-base">
                    {item.title}
                  </Text>
                  {projectTitle ? (
                    <Text numberOfLines={1} className="text-xs text-foreground-muted">
                      {projectTitle}
                    </Text>
                  ) : null}
                </Pressable>
              );
            }}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

export function AttachToThreadSheet(props: AttachToThreadSheetProps) {
  const { thread, ...body } = props;
  return (
    <Modal
      visible={thread !== null}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      {/* A Modal is its own native hierarchy, so measure its own safe area. */}
      <SafeAreaProvider style={{ flex: 1 }}>
        {thread ? <AttachToThreadBody {...body} /> : null}
      </SafeAreaProvider>
    </Modal>
  );
}
