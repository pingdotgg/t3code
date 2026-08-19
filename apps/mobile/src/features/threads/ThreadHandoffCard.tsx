import type { ThreadHandoff } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { presentThreadHandoff } from "./thread-handoff-presentation";

export function ThreadHandoffCard(props: {
  readonly handoff: ThreadHandoff;
  readonly busy?: boolean;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
}) {
  const { handoff, busy = false, onOpen, onDismiss } = props;
  const presentation = presentThreadHandoff(handoff);
  return (
    <View
      accessibilityLabel={presentation.accessibilityLabel}
      className="absolute left-3 right-3 top-2 z-20 rounded-2xl border border-border bg-surface px-3 py-2 shadow-sm"
    >
      <Text className="mb-2 text-sm text-foreground-muted">
        Ready to continue in <Text className="font-t3-bold text-foreground">{handoff.title}</Text>.
      </Text>
      {presentation.artifactReferences ? (
        <Text className="-mt-1 mb-2 text-xs text-foreground-muted" numberOfLines={1}>
          {presentation.artifactReferences}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <Pressable
          accessibilityLabel={presentation.openLabel}
          accessibilityRole="button"
          disabled={busy}
          onPress={onOpen}
          className="flex-1 items-center rounded-xl bg-primary px-3 py-2 disabled:bg-subtle-strong"
        >
          <Text className="font-t3-bold text-sm text-primary-foreground">
            {presentation.openLabel}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          disabled={busy}
          onPress={onDismiss}
          className="items-center rounded-xl bg-subtle px-3 py-2 disabled:opacity-50"
        >
          <Text className="font-t3-bold text-sm text-foreground-muted">Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}
