import { msg, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useQuietThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { alertGroupCommandFailure } from "./groupCommandFailure";
import { ThreadSettingsPickerScreen } from "./ThreadSettingsSheet";

export function ThreadGroupInviteScreen({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId; threadId: ThreadId }>) {
  const m = useMessages();
  const ref = route.params;
  const navigation = useNavigation();
  const thread = useQuietThreadShell(ref);
  const config = useEnvironmentServerConfig(ref.environmentId);
  const canInvite = useAtomValue(
    orchestrationEnvironment.inviteToGroup.permissionAtom(ref.environmentId),
  );
  const invite = useAtomCommand(orchestrationEnvironment.inviteToGroup);
  const [prompt, setPrompt] = useState("");
  const options = buildModelOptions(config, null, undefined, thread?.projectId ?? null);

  if (
    !thread ||
    !canInvite ||
    config?.settings.groupConversationsEnabled !== true ||
    thread.lineage.sideChat === true ||
    thread.lineage.relationshipToParent === "subagent"
  ) {
    return (
      <View className="flex-1 gap-4 bg-sheet p-5">
        <Text className="text-sm text-foreground-muted">
          {m(
            msg(
              "Invite models from a main thread with Group conversations enabled in Settings, Labs, Zack on this environment.",
            ),
          )}
        </Text>
        <Button label={m(msg("Close"))} onPress={() => navigation.goBack()} />
      </View>
    );
  }
  return (
    <ThreadSettingsPickerScreen
      purpose="invite"
      environmentId={ref.environmentId}
      projectId={thread.projectId}
      cwd={null}
      providerGroups={groupByProvider(options)}
      selectedModel={null}
      prompt={prompt}
      onPromptChange={setPrompt}
      onSelectModel={(option) =>
        void invite({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, modelSelection: option.selection },
        }).then((result) => alertGroupCommandFailure(m(msg("Could not invite that model")), result))
      }
      optionDescriptors={[]}
      onUpdateOptionSelections={() => {}}
      runtimeMode={thread.runtimeMode}
      onUpdateRuntimeMode={() => {}}
      onClose={() => navigation.goBack()}
    />
  );
}
