import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { PullRequestAvatar } from "./PullRequestPresentation";
import type { PullRequestCompletion } from "@t3tools/shared/pullRequestComposerTrigger";
import type { usePullRequestCompletions } from "./usePullRequestCompletions";

const COPY = {
  mention: {
    label: "Mention a user",
    pending: "Searching users...",
    failed: "Couldn't search users on the host",
    none: "No matching users",
  },
  reference: {
    label: "Reference an issue or change request",
    pending: "Searching...",
    failed: "Couldn't search the host",
    none: "No matching issues or change requests",
  },
} as const;

const STATE_LABEL = { open: "Open", closed: "Closed", merged: "Merged" } as const;

function CompletionRow({ completion }: { readonly completion: PullRequestCompletion }) {
  if (completion.kind === "mention") {
    const { actor } = completion;
    return (
      <>
        <PullRequestAvatar actor={actor} size={20} />
        <Text className="shrink-0 text-base font-t3-medium text-foreground" numberOfLines={1}>
          {actor.login}
        </Text>
        {actor.name && actor.name !== actor.login ? (
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            {actor.name}
          </Text>
        ) : null}
      </>
    );
  }
  const { candidate } = completion;
  return (
    <>
      <Text className="shrink-0 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {candidate.reference}
      </Text>
      <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
        {candidate.title}
      </Text>
      <Text className="shrink-0 text-xs text-foreground-tertiary">
        {STATE_LABEL[candidate.state]}
      </Text>
    </>
  );
}

/** The `@`, `#` and `!` suggestions for a pull request text input, rendered just above it. */
export function PullRequestCompletionSuggestions({
  completions,
}: {
  readonly completions: ReturnType<typeof usePullRequestCompletions>;
}) {
  if (completions.kind === null) return null;
  const copy = COPY[completions.kind];
  return (
    <GlassSurface
      glassEffectStyle="clear"
      tintColorClassName="accent-glass-surface"
      style={{ borderRadius: 16, overflow: "hidden" }}
    >
      {completions.candidates.length > 0 ? (
        <ScrollView
          className="max-h-[180px]"
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
          accessibilityLabel={copy.label}
        >
          {completions.candidates.map((completion, index) => (
            <Pressable
              key={completion.token}
              accessibilityRole="button"
              accessibilityLabel={`Insert ${completion.token}`}
              onPress={() => completions.select(completion)}
              className="flex-row items-center gap-2.5 border-border px-3.5 py-2.5 active:opacity-60"
              style={{
                borderBottomWidth:
                  index === completions.candidates.length - 1 ? 0 : StyleSheet.hairlineWidth,
              }}
            >
              <CompletionRow completion={completion} />
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View className="px-3.5 py-2.5">
          <Text className="text-xs text-foreground-tertiary">
            {copy[completions.isLoading ? "pending" : completions.failed ? "failed" : "none"]}
          </Text>
        </View>
      )}
    </GlassSurface>
  );
}
