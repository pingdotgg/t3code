import { useRef } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { DEFAULT_RUNTIME_MODE, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { quickChatModelSelection } from "@t3tools/client-runtime/operations/quickChats";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { uuidv4 } from "../../lib/uuid";

export function QuickChatCreationActions({
  preferredEnvironmentId,
}: {
  preferredEnvironmentId: EnvironmentId | null;
}) {
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  const navigation = useNavigation();
  const create = useAtomCommand(threadEnvironment.create, "Create quick chat");
  const pending = useRef(false);
  const eligible = environments.filter(
    (environment) => configs.get(environment.environmentId)?.environment.capabilities.quickChats,
  );
  const preferred = eligible.find(
    (environment) => environment.environmentId === preferredEnvironmentId,
  );
  const choices = preferred ? [preferred] : eligible;
  async function start(environmentId: EnvironmentId) {
    if (pending.current) return;
    const config = configs.get(environmentId);
    if (!config) return;
    const modelSelection = quickChatModelSelection(config);
    if (!modelSelection) {
      Alert.alert("Set up an agent before starting a quick chat");
      return;
    }
    pending.current = true;
    const routeKey = navigation.getState()?.routes.at(-1)?.key;
    try {
      const threadId = ThreadId.make(uuidv4());
      const result = await create({
        environmentId,
        input: {
          threadId,
          projectId: null,
          title: "New quick chat",
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) Alert.alert("Could not create quick chat");
        return;
      }
      if (navigation.getState()?.routes.at(-1)?.key === routeKey)
        (navigation.getParent() ?? navigation).dispatch(
          StackActions.replace("Thread", { environmentId, threadId }),
        );
    } finally {
      pending.current = false;
    }
  }
  if (choices.length === 0) return null;
  return (
    <View className="gap-2 pt-4">
      <Text className="text-sm font-t3-bold text-foreground">Quick chat</Text>
      {choices.map((environment) => (
        <Pressable
          key={environment.environmentId}
          className="py-3"
          accessibilityRole="button"
          onPress={() => void start(environment.environmentId)}
        >
          <Text className="text-base text-foreground">
            New quick chat{choices.length > 1 ? ` · ${environment.label}` : ""}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
