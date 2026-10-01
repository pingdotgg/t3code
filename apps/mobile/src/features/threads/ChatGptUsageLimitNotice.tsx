import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import { CHATGPT_USAGE_URL, isChatGptUsageLimitError } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useThreadDetail } from "../../state/use-thread-detail";

export function ChatGptUsageLimitNotice({
  environmentId,
  thread,
}: {
  environmentId: EnvironmentId;
  thread: OrchestrationThreadShell;
}) {
  const state = useThreadDetail({ environmentId, threadId: thread.id });
  const detail = Option.getOrNull(state.data);
  if (!isChatGptUsageLimitError(detail?.activities ?? [], thread.session?.lastError)) return null;
  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-2 gap-2 rounded-xl border border-border-subtle bg-composer-panel p-3"
    >
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider="codex" size={16} />
        <Text className="text-sm font-t3-medium text-foreground">ChatGPT usage limit reached</Text>
      </View>
      <Text className="text-xs text-foreground-muted">
        Review your usage settings in ChatGPT to continue.
      </Text>
      <Pressable
        accessibilityRole="link"
        className="min-h-11 self-start justify-center rounded-lg bg-primary px-3"
        onPress={() => void Linking.openURL(CHATGPT_USAGE_URL).catch(() => undefined)}
      >
        <Text className="text-sm font-t3-medium text-primary-foreground">Manage usage</Text>
      </Pressable>
    </View>
  );
}
