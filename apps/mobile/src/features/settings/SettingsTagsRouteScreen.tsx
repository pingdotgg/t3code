import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { validateThreadTag } from "@t3tools/client-runtime/state/threadTagFilter";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { failureMessage } from "../../lib/failureMessage";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const pluralThreads = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;

export function SettingsTagsRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const targets = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.threadTags === true,
  );

  return (
    <SettingsScreen title="Tags" menus={[environmentMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {targets.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Tags unavailable"
            detail={
              selectedTargets.length === 0
                ? "Connect to a server to rename or delete tags."
                : "Update the connected server to rename or delete tags."
            }
          />
        ) : (
          targets.map((target) => (
            <EnvironmentTags
              key={target.environmentId}
              environmentId={target.environmentId}
              title={targets.length > 1 ? target.label : undefined}
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentTags(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string | undefined;
}) {
  const { environmentId } = props;
  const usageAtom = orchestrationEnvironment.threadTagUsage({ environmentId, input: {} });
  const usage = useAtomValue(usageAtom);
  const refresh = useAtomRefresh(usageAtom);
  const canRename = useAtomValue(
    orchestrationEnvironment.renameThreadTag.permissionAtom(environmentId),
  );
  const canDelete = useAtomValue(
    orchestrationEnvironment.deleteThreadTag.permissionAtom(environmentId),
  );
  const canManage = canRename && canDelete;
  const renameTag = useAtomCommand(orchestrationEnvironment.renameThreadTag, {
    reportFailure: false,
  });
  const deleteTag = useAtomCommand(orchestrationEnvironment.deleteThreadTag, {
    reportFailure: false,
  });

  const tags = AsyncResult.isSuccess(usage) ? usage.value : [];

  const run = async (
    title: string,
    result: ReturnType<typeof renameTag> | ReturnType<typeof deleteTag>,
  ) => {
    const outcome = await result;
    if (outcome._tag === "Failure")
      Dialog.alert(title, failureMessage(outcome.cause, "The tag could not be changed."));
    refresh();
  };

  const rename = (tag: string, to: string) => {
    const validated = validateThreadTag(to, []);
    if (validated.kind === "empty") return;
    if (validated.kind === "error") {
      Dialog.alert("Could not rename tag", validated.message);
      return;
    }
    if (validated.tag === tag) return;
    const target = validated.tag;
    const lower = target.toLowerCase();
    const merges = tags.some((entry) => entry.tag !== tag && entry.tag.toLowerCase() === lower);
    const submit = () =>
      void run("Could not rename tag", renameTag({ environmentId, input: { tag, to: target } }));
    if (!merges) return submit();
    Dialog.confirm({
      title: `Merge into "${target}"?`,
      message: `"${target}" already exists. Threads tagged "${tag}" move to it.`,
      confirmText: "Merge",
      onConfirm: submit,
    });
  };

  const remove = (tag: string, threadCount: number) =>
    Dialog.confirm({
      title: `Remove "${tag}"?`,
      message: `Remove "${tag}" from ${pluralThreads(threadCount)}? This can't be undone.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () =>
        void run("Could not delete tag", deleteTag({ environmentId, input: { tag } })),
    });

  const openActions = (tag: string, threadCount: number) =>
    Dialog.alert(tag, pluralThreads(threadCount), [
      {
        text: "Rename",
        onPress: () =>
          Dialog.prompt({
            title: "Rename tag",
            initialValue: tag,
            confirmText: "Rename",
            onConfirm: (value) => rename(tag, value),
          }),
      },
      { text: "Delete", style: "destructive", onPress: () => remove(tag, threadCount) },
      { text: "Cancel", style: "cancel" },
    ]);

  return (
    <SettingsSection
      title={props.title}
      footer={canManage ? "Changes apply to every thread, including archived ones." : undefined}
    >
      {AsyncResult.isFailure(usage) ? (
        <View className="gap-3 p-4">
          <Text className="text-foreground-muted">
            {failureMessage(usage.cause, "The tag could not be changed.")}
          </Text>
          <ListRow icon="arrow.clockwise" label="Try again" onPress={refresh} />
        </View>
      ) : !AsyncResult.isSuccess(usage) ? (
        <View className="items-center p-6">
          <AppActivityIndicator />
        </View>
      ) : tags.length === 0 ? (
        <Text className="p-4 text-foreground-muted">No tags yet.</Text>
      ) : (
        tags.map((entry) => (
          <ListRow
            key={entry.tag}
            icon="tag"
            label={entry.tag}
            detail={pluralThreads(entry.threadCount)}
            disabled={!canManage}
            onPress={() => openActions(entry.tag, entry.threadCount)}
          />
        ))
      )}
    </SettingsSection>
  );
}
