import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadForkWorkspaceChoices } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  EnvironmentId,
  ThreadId,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@t3tools/contracts";
import { Modal, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { environmentThreadShells } from "../../state/threads";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";

export function ThreadForkSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly onClose: () => void;
  readonly onSelect: (workspace: OrchestrationV2ThreadLaunchWorkspaceStrategy) => void;
}) {
  const thread = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(props.environmentId, props.threadId)),
  );
  const status = useEnvironmentQuery(
    props.workspaceRoot
      ? vcsEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: props.workspaceRoot },
        })
      : null,
  );
  const choices = threadForkWorkspaceChoices({
    worktreePath: thread?.worktreePath ?? null,
    branch: thread?.branch ?? null,
    isGitRepo: status.data?.isRepo === true,
  });
  return (
    <Modal transparent visible animationType="fade" onRequestClose={props.onClose}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable
          className="absolute inset-0"
          accessibilityLabel="Dismiss fork options"
          onPress={props.onClose}
        />
        <View className="rounded-t-3xl bg-background px-5 pb-10 pt-6" accessibilityViewIsModal>
          <Text className="font-t3-semibold text-xl text-foreground">Fork thread from here</Text>
          <Text className="mb-4 mt-2 text-sm text-foreground-secondary">
            Choose where to continue from this response.
          </Text>
          {choices.map((choice) => (
            <Pressable
              key={choice.id}
              accessibilityRole="button"
              disabled={!thread}
              onPress={() => props.onSelect(choice.workspaceStrategy)}
              className="min-h-16 justify-center rounded-xl px-3 py-3 active:bg-surface"
            >
              <Text className="font-t3-medium text-base text-foreground">{choice.label}</Text>
              <Text className="mt-1 text-sm text-foreground-secondary">{choice.description}</Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="mt-2 items-center py-3"
          >
            <Text className="font-t3-medium text-base text-foreground-secondary">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
