import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { PullRequestAvatar } from "./PullRequestPresentation";
import type { usePullRequestMentions } from "./usePullRequestMentions";

/** The `@` suggestions for a pull request text input, rendered just above it. */
export function PullRequestMentionSuggestions({
  mentions,
}: {
  readonly mentions: ReturnType<typeof usePullRequestMentions>;
}) {
  if (!mentions.open) return null;
  return (
    <GlassSurface
      glassEffectStyle="clear"
      tintColorClassName="accent-glass-surface"
      style={{ borderRadius: 16, overflow: "hidden" }}
    >
      {mentions.candidates.length > 0 ? (
        <ScrollView
          className="max-h-[180px]"
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
          accessibilityLabel="Mention a user"
        >
          {mentions.candidates.map((actor, index) => (
            <Pressable
              key={actor.login}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${actor.login}`}
              onPress={() => mentions.select(actor)}
              className="flex-row items-center gap-2.5 border-border px-3.5 py-2.5 active:opacity-60"
              style={{
                borderBottomWidth:
                  index === mentions.candidates.length - 1 ? 0 : StyleSheet.hairlineWidth,
              }}
            >
              <PullRequestAvatar actor={actor} size={20} />
              <Text className="shrink-0 text-base font-t3-medium text-foreground" numberOfLines={1}>
                {actor.login}
              </Text>
              {actor.name && actor.name !== actor.login ? (
                <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                  {actor.name}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View className="px-3.5 py-2.5">
          <Text className="text-xs text-foreground-tertiary">
            {mentions.isLoading
              ? "Searching users..."
              : mentions.failed
                ? "Couldn't search users on the host"
                : "No matching users"}
          </Text>
        </View>
      )}
    </GlassSurface>
  );
}
